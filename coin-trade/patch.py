#!/usr/bin/env python3
"""coin-trade 맞춤 수정: build.py 로 다시 조립한 뒤 이 스크립트를 실행합니다.

  python3 <ai-company 스킬>/scripts/build.py company.json .
  python3 patch.py

build.py 는 스킬의 틀로 index.html 과 server.py 를 새로 만들기 때문에, 이 회사만의 변경이 사라집니다.
이 스크립트가 그 변경을 다시 넣습니다. 이미 들어 있으면 건너뜁니다.

  1) 화면 글자에서 가운뎃점과 대시를 뺍니다 (프로젝트 규칙).
  2) server.py: 포트 8989, 봇 알림 프록시(GET /api/alerts, BOT_URL 기본 http://localhost:3000).
  3) index.html: "봇 알림 받기" 버튼과 5초마다 새 알림을 가져와 판단하는 코드.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

INDEX_PAIRS = [
    (" · AI 1인 회사</title>", " | AI 1인 회사</title>"),
    (" · AI 1인 회사</h1>", " | AI 1인 회사</h1>"),
    (" — 사람은 대표 한 명", ": 사람은 대표 한 명"),
    ('<div id="demoBadge">체험 모드 · 실제 AI 아님</div>', '<div id="demoBadge">체험 모드 | 실제 AI 아님</div>'),
    ("<li>선택·점수 질문은", "<li>선택, 점수 질문은"),
    ("<h3>설정 저장·불러오기</h3>", "<h3>설정 저장/불러오기</h3>"),
    ("확신도 ${st.confidence.toFixed(2)} — 기준보다 낮음", "확신도 ${st.confidence.toFixed(2)}, 기준보다 낮음"),
    ("<li>429·529 가 나오면", "<li>429, 529 가 나오면"),
    ("cfg.actions[id].dept+' · '+cfg.actions[id].name", "cfg.actions[id].dept+' | '+cfg.actions[id].name"),
    ("${cfg.actions[res.actionId].dept} · ${cfg.actions[res.actionId].name}", "${cfg.actions[res.actionId].dept} | ${cfg.actions[res.actionId].name}"),
    ("addFinal('👑 대표에게 보냄 — '+res.reason,true)", "addFinal('👑 대표에게 보냄: '+res.reason,true)"),
    ("<b>${esc(msg.sender||'보낸 사람 없음')}</b> · ${esc(msg.subject||'')}", "<b>${esc(msg.sender||'보낸 사람 없음')}</b> | ${esc(msg.subject||'')}"),
    ("<b>${meta.ms}ms</b> · 질문 ${meta.n}개를 한 번에 요청${meta.demo?' · 체험 모드':` · 입력 토큰 ${meta.usage.input_tokens||0} · ${won(meta.usd)}`}",
     "<b>${meta.ms}ms</b> | 질문 ${meta.n}개를 한 번에 요청${meta.demo?' | 체험 모드':` | 입력 토큰 ${meta.usage.input_tokens||0} | ${won(meta.usd)}`}"),
    ("${esc(p.entry.message.sender||'')} · ${esc(p.entry.ceoRea", "${esc(p.entry.message.sender||'')} | ${esc(p.entry.ceoRea"),
    ('<option value="">— 미지정 —</option>', '<option value="">(미지정)</option>'),
    ("${ac.percent==null?'–':ac.percent+'%'}", "${ac.percent==null?'-':ac.percent+'%'}"),
    ("${esc(e.message.sender||'')} · ${esc((e.message.body||'')", "${esc(e.message.sender||'')} | ${esc((e.message.body||'')"),
    ("""            <button id="btnAuto">▶ 자동 실행</button>
""", """            <button id="btnAuto">▶ 자동 실행</button>
            <button id="btnBot" title="jev-trader 봇의 알림을 5초마다 가져와 자동으로 판단합니다">🔔 봇 알림 받기</button>
            <span class="hint" id="botState"></span>
"""),
    ("""$('#btnDemo').onclick=()=>setDemo(!ui.demo);
""", """$('#btnDemo').onclick=()=>setDemo(!ui.demo);

""" + "/* ───────── 봇 알림 자동 받기: jev-trader 의 GET /alerts 를 server.py 가 대신 가져옵니다 ───────── */\nconst BOT_KEY=COMPANY.slug+'.botAlerts';\nlet botOn=load(BOT_KEY+'.on',false),botAfter=load(BOT_KEY+'.after',null),botTm=null;\nfunction setBot(on){\n  botOn=on;save(BOT_KEY+'.on',on);clearTimeout(botTm);\n  $('#btnBot').classList.toggle('on',on);$('#btnBot').textContent=on?'🔔 봇 알림 받는 중':'🔔 봇 알림 받기';\n  if(on)botPoll();else $('#botState').textContent='';\n}\nasync function botPoll(){\n  if(!botOn)return;\n  try{\n    const r=await fetch('/api/alerts?after='+(botAfter??0));const j=await r.json();\n    if(!r.ok)throw new Error(j.error||r.status);\n    let n=0;\n    // 처음 켤 때는 지난 알림을 건너뛰고 지금부터 받습니다.\n    if(botAfter==null)botAfter=j.last;\n    else for(const a of j.alerts){enqueue({sender:a.sender,subject:a.subject,body:a.body});botAfter=a.id;n++}\n    save(BOT_KEY+'.after',botAfter);\n    $('#botState').textContent=n?`봇 알림 ${n}건 받음`:'봇 연결됨, 새 알림 기다리는 중';\n  }catch(e){$('#botState').textContent='봇에 연결할 수 없음 (jev-trader 가 켜져 있는지 확인)'}\n  botTm=setTimeout(botPoll,5000);\n}\n$('#btnBot').onclick=()=>setBot(!botOn);\nsetBot(botOn);" + """
"""),
]

SERVER_PAIRS = [
    ('PORT = int(os.environ.get("PORT", "8787"))', 'PORT = int(os.environ.get("PORT", "8989"))'),
    ("1) index.html 을 http://localhost:8787 로 보여 줍니다.", "1) index.html 을 http://localhost:8989 로 보여 줍니다."),
    ("""  2) POST /api/systemone 요청에 API 키를 붙여 TypeSafe Jev API 로 전달합니다.
""", """  2) POST /api/systemone 요청에 API 키를 붙여 TypeSafe Jev API 로 전달합니다.
  3) GET /api/alerts 로 jev-trader 봇의 알림(GET /alerts)을 대신 가져옵니다. 봇 주소는 BOT_URL (기본 http://localhost:3000).
"""),
    ("def load_key():", 'def load_env(name, default=""):\n    value = os.environ.get(name, "").strip()\n    if value:\n        return value\n    env_file = HERE / ".env"\n    if env_file.exists():\n        for line in env_file.read_text(encoding="utf-8").splitlines():\n            line = line.strip()\n            if line.startswith(name + "="):\n                return line.split("=", 1)[1].strip().strip("\\"\'")\n    return default\n\n\n' + "def load_key():"),
    ("""            return self._send(200, {"ok": True, "hasKey": bool(load_key())})
""", """            return self._send(200, {"ok": True, "hasKey": bool(load_key())})
""" + '        if path == "/api/alerts":\n            # 봇의 새 알림만: ?after=<마지막으로 본 id>\n            query = self.path.split("?", 1)[1] if "?" in self.path else ""\n            after = "".join(ch for ch in dict(p.split("=", 1) for p in query.split("&") if "=" in p).get("after", "0") if ch.isdigit()) or "0"\n            bot = load_env("BOT_URL", "http://localhost:3000").rstrip("/")\n            try:\n                with urllib.request.urlopen(f"{bot}/alerts?after={after}", timeout=5) as res:\n                    return self._send(res.status, res.read())\n            except urllib.error.HTTPError as e:\n                return self._send(e.code, e.read() or b"{}")\n            except (urllib.error.URLError, TimeoutError, OSError) as e:\n                return self._send(502, {"error": "bot_unreachable", "detail": str(e)})' + """
"""),
]


def apply(path, pairs, marker):
    text = path.read_text(encoding="utf-8")
    if marker in text:
        print(f"{path.name}: 이미 적용되어 있습니다")
        return
    for old, new in pairs:
        if old not in text:
            sys.exit(f"{path.name}: 바꿀 곳을 찾지 못했습니다: {old[:60]!r} (스킬의 틀이 바뀌었을 수 있습니다)")
        text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")
    print(f"{path.name}: 적용했습니다")


apply(HERE / "index.html", INDEX_PAIRS, 'id="btnBot"')
apply(HERE / "server.py", SERVER_PAIRS, "/api/alerts")
left = [line for line in (HERE / "index.html").read_text(encoding="utf-8").splitlines() if re.search("[·—–]", line) and "───" not in line]
if left:
    sys.exit("index.html 에 가운뎃점이나 대시가 남아 있습니다:\n" + "\n".join(l[:120] for l in left))
