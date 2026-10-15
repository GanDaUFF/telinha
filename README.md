# Telinha 🖥️

Compartilhamento de tela entre amigos, sem login. Entre com um apelido + nome da sessão (+ senha opcional).

## No ar (Cloudflare, grátis)

**https://telinha.discontaoofc.workers.dev**

Roda no Cloudflare Workers (`worker.js` + Durable Objects, uma por sessão). Para publicar alterações:

```
npm run deploy
```

## Rodar no próprio PC (alternativa)

Dê dois cliques em `iniciar.bat`, ou rode:

```
npm start        # servidor + túnel Cloudflare (link público https://xxxx.trycloudflare.com)
npm run local    # sem túnel (só http://localhost:3000)
```

O link público aparece no terminal. Ele muda a cada vez que o servidor é reiniciado.

## Como funciona

- Quem entra primeiro numa sessão **cria** ela; a senha digitada nesse momento vira a senha da sessão (deixe em branco para sessão aberta).
- A sessão some quando o último participante sai.
- Qualquer um pode compartilhar a tela, inclusive várias pessoas ao mesmo tempo. Áudio do sistema/aba também vai junto (Chrome/Edge).
- O vídeo vai **direto entre os navegadores** (WebRTC P2P). O servidor/túnel só faz a "apresentação" entre as pessoas, então não consome sua banda de upload além da sua própria transmissão.
- Máximo de 12 pessoas por sessão. Quem compartilha envia uma cópia do vídeo para cada espectador, então com muita gente a internet de quem transmite pesa.
- **Quedas:** se a conexão com o servidor cair (internet piscou, celular trocou de rede, deploy novo), a página reconecta sozinha e mostra "reconectando..." no topo, sem voltar para o menu. O servidor guarda o lugar por 30 s (no Cloudflare): voltando nesse tempo, ninguém vê a pessoa sair e a tela nem para. Depois disso, ela entra de novo sozinha e as conexões são refeitas. Só o botão **Sair** tira a pessoa na hora. (Na versão local, `server.js`, a reconexão também funciona, mas sempre refaz as conexões.)

## Qualidade

- Quem compartilha escolhe na barra de cima: **Qualidade** (automática, 1080p, 720p, 480p, 360p), **Nitidez/Fluidez** e **fps**. Dá para trocar durante a transmissão.
- Quem assiste pode pedir uma qualidade menor **só para si** no seletor da tela (útil se a internet dele é fraca). Vale a menor entre as duas escolhas.
- Cada tela mostra no canto: resolução · fps · Mbps recebidos (fica vermelho abaixo de 8 fps). Tela parada gera poucos quadros: fps baixo com a tela parada é normal.
- **60 fps:** use "Fluidez" ("Nitidez" segura a resolução e fica em ~30 fps).
- **2K e 4K:** qualidades "2K (1440p)" e "Ultra (4K)" (captura em 2560x1440 ou 3840x2160 só nesses modos; 2K até 12 Mbps direto e 5,5 no plano B; até 20 Mbps direto, 8 Mbps no plano B). Pesa bastante: use com H.264 e internet boa.
- **Assistir/parar:** o ✕ na tela de alguém para de receber a live dele (ele para de mandar, economizando internet dos dois); para voltar, "Assistir" na lista de participantes. O 🔄 na tela recarrega a conexão com aquela pessoa do zero (tela congelada/preta).
- **🔄 Trocar/reiniciar** (quem transmite): escolhe outra janela/tela ou reinicia a captura sem derrubar ninguém (troca o vídeo em todas as conexões).
- **Clipes e replay** (quem assiste, Chrome/Edge/app): cada live assistida fica numa memória curta (último ~1 min, 720p por padrão, H.264 na placa de vídeo, ~20 MB). 🎬 salva um clipe MP4 (15/30/60 s, em ⚙) e ⏪ abre um player para voltar sem largar a live. Desligável em ⚙. Código em `public/clips.js` + `public/vendor/mp4-muxer.min.js` (mp4-muxer 5.2.2, MIT).
- **🎮 Modo jogo** (quem transmite): liga H.264 (compressão na placa de vídeo, sem disputar o processador com o jogo), 720p, 30 fps, Fluidez e esconde a prévia. Desligando, volta o que estava antes. Fica lembrado no navegador.
- **Prévia:** o botão "🙈 Ocultar prévia" na sua própria tela para de desenhar sua transmissão para você (economiza o PC); os outros continuam vendo.
- **⚙ Configurações** (salvas no navegador):
  - *Suavidade* (quem assiste): "Menor atraso" (como antes), "Equilibrado" (padrão) ou "Mais suave". Quanto mais suave, mais atraso (até ~0,5 s), mas sem engasgos. No plano B os pacotes chegam em lotes de 100 ms e ficam numa fila, sendo decodificados no ritmo original.
  - *Codec* (quem compartilha): padrão do navegador (VP8, como antes), H.264 (mais fps com a placa de vídeo, mas em alguns PCs engasga), VP9 ou AV1. Muda na hora.
- O medidor mostra também quantas **travadas** aconteceram (direto: `freezeCount` do WebRTC; plano B: intervalos de mais de 300 ms).
- No plano B cada qualidade pedida tem seu próprio vídeo: quem pede 360p não derruba os outros. Cada qualidade diferente em uso aumenta um pouco o consumo de requisições do servidor.
- **Som da tela / Discord:** compartilhando a tela inteira (ou uma janela num Chrome sem `windowAudio`), vai **todo o som do PC**, inclusive o Discord. O navegador não deixa tirar só um programa. Opções: compartilhar uma **aba** (vai só o som da aba), desligar o som em 🔊, ou mandar o Discord para outra saída de áudio (no Discord: Configurações → Voz e vídeo → Dispositivo de saída). O Chrome captura só a saída **padrão** do Windows; com um cabo virtual gratuito (VB-CABLE) como saída padrão, dá para ouvir tudo no fone e deixar só o Discord de fora.
- A versão do app aparece no canto inferior esquerdo (`APP_VERSION` em `public/app.js`; aumente a cada deploy).
- Se travar: primeiro baixe a qualidade de quem está travando (seletor na tela dele); se travar para todos, quem compartilha baixa a qualidade ou o fps.

## 📋 Logs (por que a direta não pega com alguém)

O botão **📋 Logs** mostra: o tipo de rede de cada pessoa (teste automático com 3 servidores STUN ao entrar: *aberta*, *NAT cone* = direta funciona, *NAT simétrico* = comum em CGNAT/4G/empresa, direta difícil, *UDP bloqueado* = só plano B), o estado e a rota de cada conexão direta, um palpite do motivo e o histórico de eventos (servidor, conexões, plano B, erros). "Copiar logs" copia tudo em texto. Código em `public/diag.js`. O tipo de rede é estimado (o Chrome esconde algumas informações), então serve como pista, não certeza.

**🌐 Assistente de IPv6** (⚙ Configurações): testa se há IPv6 na internet (api6.ipify.org). No app também confere o Windows (adaptador/registro) e tem o botão "Ativar IPv6 no Windows" (pede administrador) e "Abrir o roteador" (gateway detectado). Roteador/operadora não dá para mudar por programa: o assistente explica o passo a passo.

## Se alguém não conseguir ver a tela: plano B

Algumas redes (CGNAT, 4G/5G, alguns provedores) bloqueiam a conexão direta entre navegadores.
Quando isso acontece, o site troca sozinho para o **plano B**: quem compartilha comprime o vídeo/áudio
no navegador (WebCodecs) e manda pelo próprio WebSocket; o servidor repassa só para quem precisa.

- É automático nos dois sentidos: um "vigia" confere a cada segundo cada tela.
  - Direta sem conectar (ou caiu) por 8 s → plano B.
  - Plano B sem imagem por 8 s → tenta a direta de novo (e vice-versa, até uma funcionar).
  - Direta voltou e ficou estável por 10 s → sai do plano B sozinho (menos atraso).
  - Quem compartilha num navegador sem plano B (Firefox/Safari) → quem assiste é avisado.
- Quem assiste pode forçar pelo botão "Plano B" na tela (e voltar com "Direto").
- Quem compartilha pode ligar "Plano B p/ todos" na barra de cima (manda para todo mundo pelo plano B).
- Cada tela mostra "direto" ou "plano B". Para testar: abra o link com `&planoB=1`.
- Quem compartilha precisa de Chrome/Edge; quem assiste pode usar Chrome, Edge ou Firefox (testado). Atraso um pouco maior que o direto.
- Custo no plano Free da Cloudflare: ~1.800 requisições/hora por tela em plano B (limite: 100 mil/dia) e ~1/28 do limite diário de duração por hora. No plano Free, estourar o limite só faz parar até 00:00 UTC (21h de Brasília); não há cobrança.
- Ainda dá para usar um servidor TURN em vez disso, via `ICE_SERVERS` (env no modo local, `npx wrangler secret put ICE_SERVERS` no Cloudflare).

## App para Windows (quem transmite)

Pasta `desktop/` (Electron) + `audio-helper/` (Rust). O app abre o próprio site publicado, então melhorias no site valem no app sem baixar de novo. Quem só assiste continua usando o navegador.

O que muda em relação ao Chrome:
- **Som sem o Discord:** o `telinha-audio.exe` captura o som por programa (recurso do Windows 10 2004+, o mesmo que o Discord usa). Em ⚙ Configurações → *Som da transmissão (app)*: "Tudo menos o Discord" (padrão), "Só o programa que estou mostrando" (ao compartilhar uma janela) ou "Todo o som do PC".
- **Seletor próprio** de janela/tela com miniaturas.
- **Sem lentidão em segundo plano** (o Chromium não "economiza" a janela atrás do jogo).
- O vídeo é o mesmo motor do Chrome: para pesar menos no jogo, use o **🎮 Modo jogo**.

Gerar o `.exe`:
```
cd audio-helper && cargo build --release      # gera telinha-audio.exe (copiar para desktop/bin/)
cd desktop && npm install && npm run dist     # gera desktop/release/Telinha-<versão>.exe (portátil)
```
Publicar o download no site (botão azul "Baixar app"): `node scripts/split-app.js desktop/release/Telinha-<versão>.exe` e depois `npm run deploy`. O Cloudflare só aceita arquivos de até 25 MB, então o `.exe` fica em pedaços de 24 MB em `public/download/` e o navegador junta tudo na hora de baixar (confere o tamanho). O botão também abre um meme numa aba nova (`MEME_URL` no `index.html`).
**Atualizações:** o app abre o site publicado, então mudanças no site chegam sozinhas (é só reabrir o app). Mudança no próprio app: aumente `version` em `desktop/package.json`, gere o `.exe`, rode o `split-app.js` e publique; o app antigo compara a versão com `download/app.json` e mostra o botão "Atualizar app", que baixa o `.exe` novo para a pasta Downloads.
Testar sem empacotar: `cd desktop && npm start` (ou `npm run local` contra o `wrangler dev` na porta 3211).
Obs.: o Electron 44 pede Node 22+ para instalar; com Node 20, baixe o zip do Electron e extraia em `desktop/node_modules/electron/dist` (com `path.txt` = `electron.exe`).
O `.exe` não é assinado: na primeira vez o Windows mostra "programa desconhecido" → *Mais informações* → *Executar assim mesmo*.
