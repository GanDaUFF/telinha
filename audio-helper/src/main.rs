#![allow(unsafe_op_in_unsafe_fn)]
// telinha-audio: captura o som do Windows por processo (WASAPI process
// loopback, Windows 10 2004+) e escreve PCM f32 estéreo 48 kHz no stdout.
//
//   telinha-audio --exclude-discord     tudo menos o Discord (padrão)
//   telinha-audio --include-hwnd <n>    só o programa dono da janela
//   telinha-audio --include-pid <pid>   só esse processo (e filhos)
//   telinha-audio --exclude-pid <pid>   tudo menos esse processo (e filhos)
//   telinha-audio --system              tudo
//
// Saída: f32 little-endian intercalado (L R L R...), sem cabeçalho. Quando
// não há som, manda silêncio para o relógio de quem consome não parar.
// Logs só no stderr. Sai quando o stdin fecha ou o stdout quebra.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, HRESULT, IUnknown};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{CoInitializeEx, IAgileObject, IAgileObject_Impl, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const RATE: u32 = 48_000;
const CH: u32 = 2;
const FRAME_BYTES: usize = (CH * 4) as usize;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Target {
    Include(u32),
    Exclude(u32),
}

enum Mode {
    ExcludeDiscord,
    Fixed(Target),
}

fn log(msg: &str) {
    eprintln!("[telinha-audio] {msg}");
}

// ---------------------------------------------------------------------------
// Saída: dados reais + silêncio para manter o fluxo constante.
// ---------------------------------------------------------------------------
struct Out {
    start: Instant,
    written: u64, // quadros escritos
}

fn write_frames(out: &Mutex<Out>, bytes: &[u8]) {
    let mut o = out.lock().unwrap();
    let mut so = std::io::stdout().lock();
    if so.write_all(bytes).and_then(|_| so.flush()).is_err() {
        std::process::exit(0); // quem nos abriu morreu
    }
    o.written += (bytes.len() / FRAME_BYTES) as u64;
}

fn silence_filler(out: Arc<Mutex<Out>>) {
    loop {
        std::thread::sleep(Duration::from_millis(10));
        let lag = {
            let o = out.lock().unwrap();
            let expected = (o.start.elapsed().as_secs_f64() * RATE as f64) as u64;
            expected.saturating_sub(o.written)
        };
        // Atrasado mais de 20 ms: completa com silêncio (deixa 10 ms de folga).
        if lag > 960 {
            let frames = (lag - 480).min(4800) as usize;
            write_frames(&out, &vec![0u8; frames * FRAME_BYTES]);
        }
    }
}

// ---------------------------------------------------------------------------
// Processos
// ---------------------------------------------------------------------------
fn processes() -> Vec<(u32, u32, String)> {
    let mut list = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return list };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                list.push((e.th32ProcessID, e.th32ParentProcessID, name));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    list
}

// Processo raiz do Discord: o Discord.exe cujo pai não é outro Discord.exe.
fn discord_root() -> Option<u32> {
    const NAMES: [&str; 3] = ["discord.exe", "discordptb.exe", "discordcanary.exe"];
    let procs = processes();
    procs
        .iter()
        .filter(|(_, _, n)| NAMES.contains(&n.as_str()))
        .find(|(_, ppid, n)| !procs.iter().any(|(pid, _, pn)| pid == ppid && pn == n))
        .map(|(pid, _, _)| *pid)
}

fn discord_target() -> Target {
    match discord_root() {
        Some(pid) => Target::Exclude(pid),
        // Sem Discord aberto: pega tudo (nós mesmos não tocamos som).
        None => Target::Exclude(unsafe { GetCurrentProcessId() }),
    }
}

// ---------------------------------------------------------------------------
// Ativação assíncrona do IAudioClient de process loopback
// ---------------------------------------------------------------------------
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Handler {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(&self, _op: Option<&IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        unsafe { SetEvent(self.done) }
    }
}

impl IAgileObject_Impl for Handler_Impl {}

// PROPVARIANT com VT_BLOB (layout x64: vt + 3 reservados, depois o BLOB).
#[repr(C)]
struct PropVariantBlob {
    vt: u16,
    r1: u16,
    r2: u16,
    r3: u16,
    cb: u32,
    pad: u32,
    data: *const u8,
}
const VT_BLOB: u16 = 65;

unsafe fn activate(target: Target) -> windows::core::Result<IAudioClient> {
    let (pid, mode) = match target {
        Target::Include(p) => (p, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        Target::Exclude(p) => (p, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE),
    };
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: mode },
        },
    };
    let pv = PropVariantBlob {
        vt: VT_BLOB,
        r1: 0,
        r2: 0,
        r3: 0,
        cb: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        pad: 0,
        data: &params as *const _ as *const u8,
    };
    let done = CreateEventW(None, false, false, None)?;
    let handler: IActivateAudioInterfaceCompletionHandler = Handler { done }.into();
    let op = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&pv as *const _ as *const windows::core::PROPVARIANT),
        &handler,
    )?;
    WaitForSingleObject(done, 10_000);
    let _ = CloseHandle(done);
    let mut hr = HRESULT(0);
    let mut unk: Option<IUnknown> = None;
    op.GetActivateResult(&mut hr, &mut unk)?;
    hr.ok()?;
    unk.ok_or_else(|| windows::core::Error::from_hresult(HRESULT(0x80004005u32 as i32)))?.cast()
}

// Captura até dar erro ou o alvo mudar (epoch != my_epoch).
unsafe fn capture(target: Target, out: &Arc<Mutex<Out>>, epoch: &AtomicU32, my_epoch: u32) -> windows::core::Result<()> {
    let client = activate(target)?;
    let fmt = WAVEFORMATEX {
        wFormatTag: windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: CH as u16,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * FRAME_BYTES as u32,
        nBlockAlign: FRAME_BYTES as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        200_000, // 20 ms
        0,
        &fmt,
        None,
    )?;
    let event = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(event)?;
    let cap: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    log(&format!("capturando: {target:?}"));

    let result = (|| {
        while epoch.load(Ordering::SeqCst) == my_epoch {
            if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
                continue;
            }
            loop {
                let n = cap.GetNextPacketSize()?;
                if n == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let len = frames as usize * FRAME_BYTES;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    write_frames(out, &vec![0u8; len]);
                } else {
                    write_frames(out, std::slice::from_raw_parts(data, len));
                }
                cap.ReleaseBuffer(frames)?;
            }
        }
        Ok(())
    })();
    let _ = client.Stop();
    let _ = CloseHandle(event);
    result
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize| -> u32 {
        args.get(i + 1).and_then(|s| s.parse::<u64>().ok()).map(|v| v as u32).unwrap_or_else(|| {
            log("faltou o número depois da opção");
            std::process::exit(2)
        })
    };
    let mode = match args.first().map(String::as_str) {
        None | Some("--exclude-discord") => Mode::ExcludeDiscord,
        Some("--system") => Mode::Fixed(Target::Exclude(unsafe { GetCurrentProcessId() })),
        Some("--include-pid") => Mode::Fixed(Target::Include(num(0))),
        Some("--exclude-pid") => Mode::Fixed(Target::Exclude(num(0))),
        Some("--include-hwnd") => {
            let hwnd = args.get(1).and_then(|s| s.parse::<isize>().ok()).unwrap_or(0);
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
            if pid == 0 {
                log("janela não encontrada");
                std::process::exit(2);
            }
            Mode::Fixed(Target::Include(pid))
        }
        Some(other) => {
            log(&format!("opção desconhecida: {other}"));
            std::process::exit(2);
        }
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // stdin fechou = quem nos abriu terminou.
    std::thread::spawn(|| {
        let mut buf = [0u8; 256];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
        std::process::exit(0);
    });

    let out = Arc::new(Mutex::new(Out { start: Instant::now(), written: 0 }));
    {
        let out = out.clone();
        std::thread::spawn(move || silence_filler(out));
    }

    // Alvo atual; o vigia do Discord troca quando o processo muda.
    let target = Arc::new(Mutex::new(match &mode {
        Mode::ExcludeDiscord => discord_target(),
        Mode::Fixed(t) => *t,
    }));
    let epoch = Arc::new(AtomicU32::new(0));
    if let Mode::ExcludeDiscord = mode {
        match *target.lock().unwrap() {
            Target::Exclude(pid) if pid != unsafe { GetCurrentProcessId() } => log(&format!("excluindo Discord (pid {pid})")),
            _ => log("Discord não está aberto: capturando tudo"),
        }
        let (target, epoch) = (target.clone(), epoch.clone());
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            let t = discord_target();
            let mut cur = target.lock().unwrap();
            if *cur != t {
                log(&format!("Discord mudou: {t:?}"));
                *cur = t;
                epoch.fetch_add(1, Ordering::SeqCst);
            }
        });
    }

    loop {
        let my_epoch = epoch.load(Ordering::SeqCst);
        let t = *target.lock().unwrap();
        match unsafe { capture(t, &out, &epoch, my_epoch) } {
            Ok(()) => {} // alvo mudou: recomeça
            Err(e) => {
                log(&format!("erro na captura: {e}; tentando de novo em 1 s"));
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
}
