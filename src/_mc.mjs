import WebSocket from 'ws';
const wsA=new WebSocket('ws://139.99.195.169:3100/ws'), wsB=new WebSocket('ws://139.99.195.169:3100/ws');
let jobId=null, ready=0;
function go(){
  setTimeout(()=>wsA.send(JSON.stringify({type:'job.claim',jobId,name:'Vector 31'})),300);
  setTimeout(()=>wsB.send(JSON.stringify({type:'job.join',jobId,name:'Vector 32'})),900);
  setTimeout(()=>wsB.send(JSON.stringify({type:'job.start',jobId})),1500);
  setTimeout(()=>wsA.send(JSON.stringify({type:'job.leave',jobId})),2200);
  setTimeout(()=>process.exit(0),3200);
}
wsA.on('open',()=>wsA.send(JSON.stringify({type:'hello',sessionId:'mc',clientId:'crewA',name:'Vector 31'})));
wsB.on('open',()=>wsB.send(JSON.stringify({type:'hello',sessionId:'mc',clientId:'crewB',name:'Vector 32'})));
wsA.on('message',d=>{const m=JSON.parse(d.toString());
  if(m.type==='job.list'&&!jobId){jobId=m.jobs.find(j=>j.channel==='raafv').id;console.log('job',jobId.slice(0,8));if(++ready===2)go();}
  if(m.type==='error')console.log('A ERROR:',m.message);
  if(m.type==='job.upsert'&&m.job.id===jobId)console.log(' upsert:',m.job.status,'phase',m.job.phase,'lead',m.job.claimedByName,'party',(m.job.party||[]).map(p=>p.name).join('+'));
});
wsB.on('message',d=>{const m=JSON.parse(d.toString());if(m.type==='job.list'&&!jobId){jobId=m.jobs.find(j=>j.channel==='raafv').id;if(++ready===2)go();} if(m.type==='error')console.log('B ERROR:',m.message);});
