// Isolated whiteboard integration test: actual client, policy and WebSockets.
// This does not start mediasoup or establish audio/video calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';
import { createWhiteboard } from '../whiteboard.js';

const markup = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = markup.match(/<style>([\s\S]*?)<\/style>/)[1];
const panel = markup.slice(markup.indexOf('<section id="boardPanel"'), markup.indexOf('<section class="panel" aria-label="Meeting recording">'));
const client = await readFile(new URL('../client/whiteboard.js', import.meta.url), 'utf8');
const html = `<!doctype html><style>${styles}</style><main><button id="boardToggle">Whiteboard</button>${panel}</main>
<script type="module">
import { setupWhiteboard } from '/client.js';
const state = { joined: false }, pending = new Map();
let serial = 0;
const ws = new WebSocket(location.origin.replace('http', 'ws') + location.search);
function rpc(method, data = {}) {
  return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,data}));});
}
const board = setupWhiteboard({$:id=>document.getElementById(id),state,rpc});
window.testRpc = rpc;
ws.onmessage = ({data}) => {
 const m=JSON.parse(data);
 if(m.event==='joined') {Object.assign(state,m.data.state);board.load(m.data.board);board.refresh();window.ready=true;}
 else if(m.event) board.receive(m.event,m.data);
 else {const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}
};
</script>`;
const rooms = new Map(), peers = new Map();
const server = createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/client.js'?'text/javascript':'text/html');res.end(req.url==='/client.js'?client:html);});
const sockets = new WebSocketServer({server});
sockets.on('connection',(ws,req)=>{
 const key = new URL(req.url,'http://localhost').searchParams.get('room') || 'shared';
 if(!rooms.has(key)) rooms.set(key,{policy:createWhiteboard(),ownerAssigned:false});
 const room=rooms.get(key), peer={id:randomUUID(),username:'Tester',role:room.ownerAssigned?'participant':'owner'};
 room.ownerAssigned=true;peers.set(ws,{room,peer});
 ws.send(JSON.stringify({event:'joined',data:{state:{joined:true,peerId:peer.id,room:{role:peer.role}},board:room.policy.snapshot()}}));
 ws.on('message',raw=>{
  const request=JSON.parse(raw);
  try {
   const operation={whiteboardAdd:'add',whiteboardUndo:'undo',whiteboardClear:'clear',whiteboardShow:'show'}[request.method];
   if(!operation) throw Error('Unknown method');
   const result=room.policy[operation](peer,request.data);
   for(const [socket,member] of peers) if(member.room===room&&socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify({event:request.method,data:result}));
   ws.send(JSON.stringify({id:request.id,result:{}}));
  } catch(error) {ws.send(JSON.stringify({id:request.id,error:error.message}));}
 });
 ws.on('close',()=>peers.delete(ws));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
 const errors=[];
 const open=async(room='shared')=>{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=${room}`);
  await page.waitForFunction(()=>window.ready);return page;
 };
 const owner=await open(), guest=await open(), separate=await open('other');
 await owner.locator('#boardToggle').click();
 await owner.locator('#boardPresent').click();
 await guest.locator('#boardPanel').waitFor({state:'visible'});
 assert.equal(await separate.locator('#boardPanel').isVisible(),false);
 assert.equal(await guest.locator('#boardClear').isVisible(),false);
 assert.match(await guest.evaluate(()=>window.testRpc('whiteboardClear').then(()=>'',e=>e.message)),/owner/);
 const pixel=(page,x,y)=>page.evaluate(([x,y])=>Array.from(document.querySelector('#boardCanvas').getContext('2d').getImageData(x,y,1,1).data),[x,y]);
 const waitPixel=(page,x,y,white)=>page.waitForFunction(({x,y,white})=>{
  const p=document.querySelector('#boardCanvas').getContext('2d').getImageData(x,y,1,1).data;
  return (p[0]===255&&p[1]===255&&p[2]===255&&p[3]===255)===white;
 },{x,y,white});
 const gesture=async(page,tool,a,b,release=true)=>{
  await page.locator('#boardTool').selectOption(tool);
  await page.locator('#boardCanvas').scrollIntoViewIfNeeded();
  const box=await page.locator('#boardCanvas').boundingBox();
  const point=([x,y])=>[box.x+x*box.width/1200,box.y+y*box.height/675];
  await page.mouse.move(...point(a));await page.mouse.down();await page.mouse.move(...point(b),{steps:10});
  if(release) await page.mouse.up();
 };
 await gesture(owner,'pencil',[100,200],[500,200]);
 await waitPixel(guest,150,200,false);
 await guest.locator('#boardSize').selectOption('24');
 await gesture(guest,'eraser',[300,150],[300,250]);
 await waitPixel(owner,300,200,true);await waitPixel(guest,300,200,true);
 assert.notDeepEqual(await pixel(owner,150,200),[255,255,255,255]);
 const late=await open();await late.locator('#boardPanel').waitFor({state:'visible'});
 await waitPixel(late,300,200,true);await waitPixel(late,150,200,false);
 await guest.locator('#boardUndo').click();await waitPixel(owner,300,200,false);await waitPixel(late,300,200,false);
 // Presentation must not discard another participant's in-progress stroke.
 await gesture(guest,'pencil',[100,350],[500,350],false);
 await owner.locator('#boardPresent').click();await guest.mouse.up();
 await waitPixel(owner,200,350,false);
 await guest.locator('#boardClose').click();
 await gesture(owner,'rectangle',[650,100],[850,300]);
 await guest.locator('#boardToggle').click();await waitPixel(guest,650,200,false);
 const downloadEvent=owner.waitForEvent('download');await owner.locator('#boardSave').click();
 assert.equal((await downloadEvent).suggestedFilename(),'meeting-whiteboard.png');
 await owner.evaluate(()=>window.testRpc('whiteboardClear'));
 for(const page of [owner,guest,late]) await waitPixel(page,150,200,true);
 await separate.locator('#boardToggle').click();await waitPixel(separate,150,200,true);
 assert.deepEqual(errors,[]);
 console.log('PASS: four browser sessions; presentation, room isolation, shared ink, partial erasure, undo, late join, unfinished stroke preservation, hidden-panel updates, PNG, owner-only clear; no browser errors.');
 console.log('Scope: whiteboard client/policy over WebSockets; audio/video meeting integration remains a separate check.');
} finally {
 await browser?.close();
 for(const ws of sockets.clients) ws.terminate();
 await new Promise(resolve=>sockets.close(resolve));
 await new Promise(resolve=>server.close(resolve));
}
