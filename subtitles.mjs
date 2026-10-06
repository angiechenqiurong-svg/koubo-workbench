const normalize=text=>text.replace(/[\s\p{P}]/gu,'');
function similar(a,b){a=normalize(a);b=normalize(b);if(Math.min(a.length,b.length)<6||/[不没无]/.test(a)!==/[不没无]/.test(b))return false;let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]===b[j]?0:1)));row=next;}return row[b.length]<=Math.max(1,Math.floor(Math.max(a.length,b.length)*.18));}
export function subtitleSegments(frames,duration,interval,audioText=''){
  if(frames.length<4)return null;
  const seen=new Map();
  const rows=frames.map(f=>({time:f.time,items:f.items.filter(x=>x.confidence>=0.6&&/[\p{Script=Han}]/u.test(x.text)&&!/(抖音|抖音号|点赞|关注|分享|评论|下载App|douyin)/i.test(x.text))}));
  for(const f of rows)for(const key of new Set(f.items.map(x=>normalize(x.text))))seen.set(key,(seen.get(key)||0)+1);
  const dynamic=rows.map(f=>({time:f.time,items:f.items.filter(x=>(seen.get(normalize(x.text))||0)<frames.length*.6)}));
  // Persistent titles/logos are removed. Prefer the spatial band with the
  // most changing Chinese text so unrelated labels don't become narration.
  const bands=new Map();for(const f of dynamic)for(const row of f.items){const band=Math.floor((row.y+row.h/2)*10);bands.set(band,(bands.get(band)||0)+normalize(row.text).length);}
  const dominant=[...bands].sort((a,b)=>b[1]-a[1])[0]?.[0];if(dominant===undefined)return null;
  const captions=dynamic.map(f=>({time:f.time,text:f.items.filter(x=>Math.abs((x.y+x.h/2)*10-dominant-.5)<=1.8).sort((a,b)=>Math.abs(a.y-b.y)<.02?a.x-b.x:b.y-a.y).map(x=>x.text.trim()).join('')})).filter(x=>x.text.length>=3);
  if(captions.length<frames.length*.55)return null;
  const result=[];for(const c of captions){const previous=result.at(-1);if(previous&&normalize(previous.text)===normalize(c.text)&&c.time<=previous.end+interval*1.5)previous.end=Math.min(duration,c.time+interval);else result.push({start:c.time,end:Math.min(duration,c.time+interval),text:c.text});}
  // Remove one-frame OCR flicker when adjacent stable frames agree.
  for(let i=0;i<result.length;i++){const current=result[i],previous=result[i-1],next=result[i+1];if(current.end-current.start>interval*1.1)continue;
    if(previous&&next&&normalize(previous.text)===normalize(next.text)&&similar(previous.text,current.text)&&next.start-previous.end<=interval*2.1){previous.end=next.end;result.splice(i,2);i--;}
    else if(next&&next.end-next.start>=interval*2&&similar(current.text,next.text)&&next.start-current.end<=interval*1.1){next.start=current.start;result.splice(i,1);i--;}
  }
  const chars=result.reduce((n,s)=>n+normalize(s.text).length,0);
  if(chars<normalize(audioText).length*.65||chars<12)return null;
  return result;
}
