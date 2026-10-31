#!/usr/bin/env bash
# Список постов: номер, раздел, день, статус, начало текста и кнопки (только чтение).
cd /opt/di-sign-bot/bot
set -a; . /etc/di-sign-bot.env; set +a
node --no-warnings -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.DB_FILE||"./data/bot.db",{readOnly:true});
for(const p of db.prepare("SELECT id,kind,day,mode,status,title,text,buttons,send_time FROM posts WHERE status!=\"archived\" ORDER BY kind,day,id").all()){
  let b=""; try{b=JSON.parse(p.buttons||"[]").flat().map(x=>x.text+(x.go?"->#"+x.go:x.url?"->url":x.lead?"->заявка":"")).join(" | ")}catch{}
  console.log("#"+p.id,p.kind,"д"+p.day,p.mode||"",p.status,"«"+String(p.title||p.text||"").split("\n")[0].slice(0,40)+"»",b?"["+b+"]":"");
}'
