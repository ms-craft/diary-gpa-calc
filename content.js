(async () => {
const P='\x25';
const pid=(location.pathname.match(/\/pupil\/(\d+)/)||[])[1]||'3935563';
let qs=[...document.querySelectorAll('[id^="db_quarters_menu_"] a[quarter_id]')].map(a=>({id:a.getAttribute('quarter_id'),name:a.textContent.trim()}));
if(!qs.length)qs=[92,93,94,95].map((id,i)=>({id:String(id),name:(i+1)+' четверть'}));
const win=window.open('','_blank');
const say=t=>{win.document.body.innerHTML='<p style="font:16px sans-serif">'+t+'</p>';};
say('Собираю оценки…');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>s.replace(/\s+/g,' ').trim();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const f2=x=>x.toFixed(2);
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
const marksOf=tbl=>[...tbl.querySelectorAll('td.mark')].map(td=>clean(td.textContent)).join('|');
const now=new Date();
const stamp=now.toISOString().slice(0,10);
const y=now.getMonth()>=7?now.getFullYear():now.getFullYear()-1;
const d0=new Date(Date.UTC(y,8,1));
d0.setUTCDate(d0.getUTCDate()-[6,0,1,2,3,4,5][d0.getUTCDay()]);
const weeks=[];
for(const d=new Date(d0);d<=now;d.setUTCDate(d.getUTCDate()+7))weeks.push(d.toISOString().slice(0,10));
async function get(url){
for(let a=0;a<3;a++){
const ac=new AbortController(),t=setTimeout(()=>ac.abort(),20000);
try{
const r=await fetch(url,{credentials:'include',signal:ac.signal,headers:{'X-Requested-With':'XMLHttpRequest'}});
clearTimeout(t);
if(r.ok)return await r.text();
if(r.status===403||r.status===404)return'';
}catch(e){clearTimeout(t);}
await sleep(800*(a+1));
}
return null;
}
const seen=new Set();
const data=new Map();
let lessons=0,failed=0,dups=0,diffs=0;
const tasks=[];
for(const q of qs){
    for(const w of weeks) tasks.push({q,w});
}

let completed=0;
const totalTasks=tasks.length;
const CONCURRENCY=8;

const updateProgress=()=>{
    const pct=totalTasks ? Math.round(completed/totalTasks*100) : 100;
    say('Загружаю оценки… '+completed+' / '+totalTasks+' ('+pct+'%)');
};

async function worker(){
    while(true){
        const task=tasks.pop();
        if(!task)return;

        const q=task.q, w=task.w;
        const html=await get('/pupil/'+pid+'/dnevnik/quarter/'+q.id+'/week/'+w);

        completed++;
        updateProgress();

        if(html===null){
            failed++;
            continue;
        }

        const doc=new DOMParser().parseFromString(html,'text/html');
        const byId=new Map();

        doc.querySelectorAll('table.db_table').forEach(tbl=>{
            const prev=byId.get(tbl.id);
            if(prev){
                dups++;
                if(marksOf(prev)!==marksOf(tbl))diffs++;
            }
            byId.set(tbl.id,tbl);
        });

        byId.forEach((tbl,id)=>{
            const m=id.match(/db_table_(\d\d)\.(\d\d)\.(\d\d)/);
            const date=m?'20'+m[3]+'-'+m[2]+'-'+m[1]:w;

            tbl.querySelectorAll('tbody tr').forEach(tr=>{
                const lc=tr.querySelector('td.lesson');
                if(!lc)return;

                const t=clean(lc.textContent);
                const mm=t.match(/^(\d+)\.\s*(.+)$/);
                const n=mm?mm[1]:'',subject=mm?mm[2]:t;

                lessons++;

                const mc=tr.querySelector('td.mark');
                if(!mc||!subject)return;

                [...mc.querySelectorAll('.mark_box strong, strong')]
                    .map(s=>clean(s.textContent))
                    .filter(x=>/^\d{1,2}$/.test(x))
                    .forEach((x,i)=>{
                        const key=date+'|'+n+'|'+subject+'|'+i;
                        if(seen.has(key))return;
                        seen.add(key);

                        if(!data.has(subject))data.set(subject,[]);
                        data.get(subject).push({
                            date,n,v:+x,q:q.id
                        });
                    });
            });
        });
    }
}

updateProgress();

await Promise.all(
    Array.from(
        {length:Math.min(CONCURRENCY,totalTasks)},
        ()=>worker()
    )
);

if(!lessons){say('Уроков не нашлось (загрузка не удалась или разметка изменилась). Запусти ещё раз.');return;}
if(!data.size){say('Уроков: '+lessons+', но оценок пока нет. Неудачных запросов: '+failed+'.');return;}
const rows=[...data.entries()].map(([subject,list])=>{
list.sort((a,b)=>a.date.localeCompare(b.date)||a.n-b.n);
return{subject,list,avg:avg(list.map(o=>o.v))};
}).sort((a,b)=>a.subject.localeCompare(b.subject,'ru'));
const flat=rows.flatMap(r=>r.list);
const all=flat.map(o=>o.v);
const mean=avg(all);
const sorted=[...rows].sort((a,b)=>b.avg-a.avg);
const ruDate=s=>s.slice(8)+'.'+s.slice(5,7);
const lerp=(a,b,t)=>Math.round(a+(b-a)*t);
const col=(v,k=0)=>{
const t=Math.max(0,Math.min(1,(v-3)/7));
const A=[226,85,75],B=[245,190,60],C=[52,170,100];
const lo=t<0.5?A:B,hi=t<0.5?B:C,u=t<0.5?t*2:(t-0.5)*2;
return 'rgb('+[0,1,2].map(i=>lerp(lerp(lo[i],hi[i],u),255,k)).join(',')+')';
};
const qa=(list,id)=>{const a=list.filter(o=>o.q===id).map(o=>o.v);return a.length?avg(a):null;};
const c1=(()=>{
const W=820,L=150,R=60,T=30,rh=32,H=T+sorted.length*rh+34;
const sx=v=>L+(W-L-R)*v/10;
let s='<svg viewBox="0 0 '+W+' '+H+'" style="width:100'+P+';max-width:'+W+'px;font:13px sans-serif">';
for(let t=0;t<=10;t+=2){s+='<line x1="'+sx(t)+'" x2="'+sx(t)+'" y1="'+T+'" y2="'+(H-30)+'" stroke="rgb(226,228,234)"/><text x="'+sx(t)+'" y="'+(H-12)+'" text-anchor="middle" fill="rgb(120,125,140)">'+t+'</text>';}
sorted.forEach((r,i)=>{
const yy=T+i*rh;
s+='<text x="'+(L-10)+'" y="'+(yy+rh/2)+'" text-anchor="end" dominant-baseline="middle" fill="rgb(40,44,60)">'+esc(r.subject)+'</text><rect x="'+L+'" y="'+(yy+4)+'" width="'+(sx(r.avg)-L)+'" height="'+(rh-10)+'" rx="6" fill="'+col(r.avg)+'"/><text x="'+(sx(r.avg)+8)+'" y="'+(yy+rh/2)+'" dominant-baseline="middle" font-weight="bold" fill="rgb(40,44,60)">'+f2(r.avg)+'</text>';
});
s+='<line x1="'+sx(mean)+'" x2="'+sx(mean)+'" y1="'+(T-8)+'" y2="'+(H-30)+'" stroke="rgb(60,80,200)" stroke-dasharray="5 4" stroke-width="2"/><text x="'+sx(mean)+'" y="'+(T-14)+'" text-anchor="middle" fill="rgb(60,80,200)" font-weight="bold">общий '+f2(mean)+'</text>';
return s+'</svg>';
})();
const c2=(()=>{
const W=520,H=240,L=14,B=34,T=26;
const cnt=Array(11).fill(0);
all.forEach(v=>{if(v>=0&&v<=10)cnt[v]++;});
const mx=Math.max(...cnt,1),bw=(W-2*L)/10;
let s='<svg viewBox="0 0 '+W+' '+H+'" style="width:100'+P+';max-width:'+W+'px;font:13px sans-serif"><line x1="'+L+'" x2="'+(W-L)+'" y1="'+(H-B)+'" y2="'+(H-B)+'" stroke="rgb(200,203,215)"/>';
for(let v=1;v<=10;v++){
const h=(H-T-B)*cnt[v]/mx,x=L+(v-1)*bw+5,yy=H-B-h;
s+='<rect x="'+x+'" y="'+yy+'" width="'+(bw-10)+'" height="'+h+'" rx="6" fill="'+col(v)+'"/>';
if(cnt[v])s+='<text x="'+(x+(bw-10)/2)+'" y="'+(yy-7)+'" text-anchor="middle" font-weight="bold" fill="rgb(40,44,60)">'+cnt[v]+'</text>';
s+='<text x="'+(x+(bw-10)/2)+'" y="'+(H-B+20)+'" text-anchor="middle" fill="rgb(120,125,140)">'+v+'</text>';
}
return s+'</svg>';
})();
const kp=(label,val,sub,c)=>'<div class="kpi" style="background:'+c+'"><div class="kl">'+label+'</div><div class="kv">'+val+'</div><div class="ks">'+sub+'</div></div>';
const qKpis=qs.map(q=>{
const a=flat.filter(o=>o.q===q.id).map(o=>o.v);
return a.length?kp(esc(q.name),f2(avg(a)),a.length+' оц.',col(avg(a),0.55)):kp(esc(q.name),'—','нет оценок','rgb(236,237,243)');
}).join('');
const best=sorted[0],worst=sorted[sorted.length-1];
const cellT=x=>x==null?'<td class="mut">—</td>':'<td style="background:'+col(x,0.6)+'"><b>'+f2(x)+'</b></td>';
const summary='<table class="tbl"><tr><th>Предмет</th>'+qs.map(q=>'<th>'+esc(q.name)+'</th>').join('')+'<th>Итого</th><th>Оценок</th></tr>'
+rows.map(r=>'<tr><td>'+esc(r.subject)+'</td>'+qs.map(q=>cellT(qa(r.list,q.id))).join('')+cellT(r.avg)+'<td>'+r.list.length+'</td></tr>').join('')
+'<tr class="sum"><td>Все предметы</td>'+qs.map(q=>cellT(qa(flat,q.id))).join('')+cellT(mean)+'<td>'+all.length+'</td></tr></table>';
const cards=rows.map(r=>{
let s='<div class="card"><h3>'+esc(r.subject)+'<span class="badge" style="background:'+col(r.avg)+'">'+f2(r.avg)+'</span></h3><table class="tbl"><tr><th>Дата</th><th>Урок</th><th>Оценка</th></tr>';
r.list.forEach(o=>{s+='<tr><td>'+ruDate(o.date)+'</td><td>'+(o.n?o.n+' урок':'')+'</td><td><span class="m" style="background:'+col(o.v)+'">'+o.v+'</span></td></tr>';});
s+='<tr class="head"><th colspan="3">По четвертям</th></tr>';
qs.forEach(q=>{
const c=r.list.filter(o=>o.q===q.id).length;
s+='<tr><td>'+esc(q.name)+'</td><td>'+(c?c+' оц.':'')+'</td>'+cellT(qa(r.list,q.id))+'</tr>';
});
s+='<tr class="sum"><td>Итого</td><td>'+r.list.length+' оц.</td>'+cellT(r.avg)+'</tr></table></div>';
return s;
}).join('');
const css='*{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{size:A4;margin:12mm}body{font:15px/1.45 "Segoe UI",system-ui,sans-serif;margin:0;background:rgb(244,245,250);color:rgb(35,38,55)}.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}.top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:6px}h1{margin:0;font-size:28px}h2{margin:0 0 12px;font-size:18px}button{border:0;border-radius:10px;padding:9px 16px;margin-left:8px;background:rgb(60,80,200);color:white;font:inherit;cursor:pointer}.hint{margin:0 0 16px;color:rgb(120,125,140);font-size:13px}.panel{background:white;border-radius:14px;padding:18px 22px;margin:0 0 20px;box-shadow:0 1px 4px rgba(20,25,60,.08)}.kpis{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px}.kpi{flex:1 1 150px;border-radius:14px;padding:14px 18px;box-shadow:0 1px 4px rgba(20,25,60,.08)}.kl{font-size:13px;color:rgb(70,74,95)}.kv{font-size:30px;font-weight:700;line-height:1.2}.ks{font-size:12px;color:rgb(70,74,95)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}.card{background:white;border-radius:14px;padding:16px 18px;box-shadow:0 1px 4px rgba(20,25,60,.08)}.card h3{margin:0 0 10px;display:flex;justify-content:space-between;align-items:center;font-size:17px}.badge{border-radius:20px;padding:2px 12px;font-size:15px}.tbl{border-collapse:collapse;width:100'+P+'}.tbl th,.tbl td{padding:6px 10px;text-align:left;border-bottom:1px solid rgb(236,237,243)}.tbl th{background:rgb(244,245,250);font-weight:600;font-size:13px}.tbl .head th{background:rgb(232,235,250)}.tbl .sum td{font-weight:700;border-top:2px solid rgb(200,203,215)}.mut{color:rgb(150,153,170)}.m{display:inline-block;min-width:26px;text-align:center;border-radius:8px;padding:1px 6px;font-weight:700}.note{color:rgb(120,125,140);font-size:13px}@media print{body{background:white}.wrap{padding:0}.noprint{display:none}.panel,.card,.kpi{box-shadow:none;border:1px solid rgb(225,227,235);break-inside:avoid}.grid{grid-template-columns:repeat(2,1fr)}}';
const out='<meta charset="utf-8"><title>Оценки '+stamp+'</title><style>'+css+'</style><div class="wrap"><div class="top"><h1>Оценки</h1><div class="noprint"><button id="dl">Скачать CSV для Excel</button><button id="pr">Сохранить в PDF</button></div></div>'
+'<p class="hint noprint">Кнопка «Сохранить в PDF» открывает окно печати: в поле «Принтер» выбери «Сохранить как PDF».</p>'
+'<div class="kpis">'+kp('Общий средний балл',f2(mean),all.length+' оценок',col(mean,0.55))+qKpis+kp('Лучший предмет',f2(best.avg),esc(best.subject),col(best.avg,0.55))+kp('Слабейший предмет',f2(worst.avg),esc(worst.subject),col(worst.avg,0.55))+'</div>'
+(failed?'<p style="color:rgb(200,30,30)">Не загрузилось недель: '+failed+' — запусти ещё раз</p>':'')
+'<div class="panel"><h2>Средний балл по предметам</h2>'+c1+'</div>'
+'<div class="panel"><h2>Распределение оценок</h2>'+c2+'</div>'
+'<div class="panel"><h2>Сводка по четвертям</h2>'+summary+'</div>'
+'<h2>Все оценки по предметам</h2><div class="grid">'+cards+'</div>'
+'<p class="note">Служебная проверка: повторяющихся таблиц дней — '+dups+', из них с разными отметками — '+diffs+' (использована последняя копия).</p></div>';
win.document.open();
win.document.write(out);
win.document.close();
win.document.title='Оценки '+stamp;
const nf=x=>x==null?'':f2(x).replace('.',',');
const csv='\ufeff'+['Предмет;'+qs.map(q=>q.name).join(';')+';Всего;Оценки',
...rows.map(r=>'"'+r.subject+'";'+qs.map(q=>nf(qa(r.list,q.id))).join(';')+';'+nf(r.avg)+';'+r.list.map(o=>o.v).join(';')),
'"ВСЕГО";'+qs.map(q=>nf(qa(flat,q.id))).join(';')+';'+nf(mean)+';'].join('\r\n');
win.document.getElementById('dl').onclick=()=>{
const a=win.document.createElement('a');
a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
a.download='ocenki.csv';
a.click();
};
win.document.getElementById('pr').onclick=()=>{win.focus();win.print();};
})();
