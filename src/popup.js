const $=id=>document.getElementById(id);
function request(type,body={}){
 return chrome.runtime.sendMessage({target:'background',type,...body}).then(r=>{if(!r?.ok)throw new Error(r?.error||'No reply');return r;});
}
function say(text){$('status').textContent=text;}
function show(r){
 const s=r.settings,c=r.counts;
 $('positive').textContent=c.positive; $('negative').textContent=c.negative;
 $('ready').textContent=c.ready?'Active':'Training';
 $('enabled').checked=s.enabled;
 $('threshold').value=Math.round(s.threshold*100);
 $('exploration').value=Math.round(s.exploration*100);
 $('drift').value=String(s.driftStdPerWeek??0.12);
 $('threshold-value').textContent=`${Math.round(s.threshold*100)}%`;
 $('exploration-value').textContent=`${Math.round(s.exploration*100)}%`;
}
$('threshold').addEventListener('input',()=>{$('threshold-value').textContent=$('threshold').value+'%';});
$('exploration').addEventListener('input',()=>{$('exploration-value').textContent=$('exploration').value+'%';});
$('save').addEventListener('click',async()=>{
 try{const r=await request('SET_SETTINGS',{settings:{enabled:$('enabled').checked,threshold:Number($('threshold').value)/100,exploration:Number($('exploration').value)/100,driftStdPerWeek:Number($('drift').value)}});show(r);say('Saved. Reload the LinkedIn tab to apply the new policy.');}
 catch(e){say('Error: '+e.message);}
});
$('export').addEventListener('click',async()=>{
 try{const r=await request('EXPORT');
   const blob=new Blob([JSON.stringify(r,null,2)],{type:'application/json'});
   const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='algosteer-labels.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
   say(`Exported ${r.labels.length} labels (text + ratings, no embeddings).`);
 }catch(e){say('Error: '+e.message);}
});
$('reset').addEventListener('click',async()=>{
 if(!confirm('Delete every saved More/Less rating? This cannot be undone. Export first if you want a backup.'))return;
 try{const r=await request('RESET');show(r);say('Labels cleared. Reload LinkedIn to restart training.');}catch(e){say('Error: '+e.message);}
});
request('STATUS').then(r=>{show(r);say(`Inference status: ${r.status}. ${r.counts.ready?'Filtering enabled when toggled on.':'Needs at least 12 ratings, including 3 More and 3 Less.'}`);}).catch(e=>say('Error: '+e.message));
