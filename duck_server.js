const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const http = require('http');
const path = require('path');

const CHANNEL_ID = 'ff67026a61e0e2688583047d042a715f';
const PORT = process.env.PORT || 6001;

const app = express();
const server = http.createServer(app);

// 정적 파일 제공 (음성파일, 이미지 등)
app.use(express.static(__dirname));

// 루트 주소 접속 시 HTML 파일 제공
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '샌드백 채팅창.html'));
});

const wss = new WebSocket.Server({ server });
let pingInterval;
let retryCount = 0; // 재접속 횟수 관리

async function getChatInfo(channelId) {
    try {
        const url = `https://api.chzzk.naver.com/polling/v2/channels/${channelId}/live-status`;
        const response = await axios.get(url, { timeout: 8000 });
        const chatChannelId = response.data.content.chatChannelId;

        const tokenUrl = `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`;
        const tokenRes = await axios.get(tokenUrl, { timeout: 8000 });

        return { chatChannelId, accessToken: tokenRes.data.content.accessToken };
    } catch (err) { throw err; }
}

async function connectChzzk() {
    try {
        if (pingInterval) clearInterval(pingInterval);
        const info = await getChatInfo(CHANNEL_ID);

        // 타임아웃을 늘려 게임 중 네트워크 지연에 대비
        const socket = new WebSocket('wss://kr-ss1.chat.naver.com/chat', { handshakeTimeout: 20000 });

        socket.on('open', () => {
            console.log("✅ 채팅 서버 연결 성공! (안정 모드)");
            retryCount = 0; // 연결 성공 시 재접속 횟수 초기화

            const openMsg = {
                ver: "2", cmd: 100, svcid: "game", cid: info.chatChannelId, tid: 1,
                bdy: { accTkn: info.accessToken, auth: "READ", devType: 2001, uid: "" }
            };
            socket.send(JSON.stringify(openMsg));

            // 핑 주기를 20초로 늘려 네트워크 패킷 발생 최소화
            pingInterval = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ver: "2", cmd: 10000 }));
            }, 20000);
        });

        socket.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if ((msg.cmd === 93101 || msg.cmd === 93102) && msg.bdy) {
                    msg.bdy.forEach(chat => {
                        const profile = chat.profile ? JSON.parse(chat.profile) : { nickname: '시스템' };
                        const extras = chat.extras ? JSON.parse(chat.extras) : {};
                        const isDonation = (msg.cmd === 93102) || (chat.msgTypeCode === 10);
                        const chatData = JSON.stringify({
                            nickname: profile.nickname,
                            message: chat.msg || '',
                            emojis: extras.emojis || {},
                            isDonation: isDonation
                        });
                        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(chatData); });
                    });
                }
                if (msg.cmd === 0) socket.send(JSON.stringify({ ver: "2", cmd: 10000 }));
            } catch (e) { }
        });

        socket.on('error', () => socket.terminate());

        socket.on('close', () => {
            clearInterval(pingInterval);
            // 재접속 대기 시간을 5초에서 최대 30초까지 늘려 게임 간섭 방지
            const delay = Math.min(5000 * Math.pow(1.5, retryCount), 30000);
            console.log(`⚠️ 연결 유지 실패. ${Math.round(delay / 1000)}초 후 재시도...`);
            setTimeout(() => {
                retryCount++;
                connectChzzk();
            }, delay);
        });
    } catch (e) {
        setTimeout(connectChzzk, 15000); // API 에러 시 15초 후 재시도
    }
}

console.log(`[오리 서버] 저사양/게임 안정 모드 가동`);
connectChzzk();

server.listen(PORT, () => {
    console.log(`✅ 웹 서버 가동 완료! (포트: ${PORT})`);
    console.log(`👉 OBS 브라우저 소스 주소: http://localhost:${PORT}`);
});