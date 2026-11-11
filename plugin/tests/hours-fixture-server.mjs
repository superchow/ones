// Local browser fixture: production UI, fictional Worker data, no real writes.
// node --experimental-transform-types tests/hours-fixture-server.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import activate from './fixtures/html-worker.ts'
const handlers = new Map()
activate({ panels: { handle: (name, handler) => handlers.set(name, handler) } })
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/src/html/panel.css"><style>body{max-width:700px;margin:auto;padding:20px}</style><main id="fixture-root"></main><script type="module">
import {WorkbenchUI} from '/src/html/panel.ts';
window.calls=[];
window.fixture={times:['18:30','09:00'],existing:30,failProjects:false,holdProjects:false,enabled:true};
window.orca={on:()=>({dispose(){}}),host:{call:async(_method,{name,input={}})=>{
  calls.push({name,input}); const f=window.fixture;
  if(name==='preferences.load')return {output:{ok:true,value:{version:1,accounts:{ones:'',coho:''},tab:'hours',git:{emails:'',allAuthors:false},teams:{},profiles:{}}}};
  if(name==='preferences.update')return {output:{ok:true,value:{saved:true}}};
  if(name==='git.projects.load'){
    if(f.holdProjects)await new Promise(resolve=>{window.releaseProjects=resolve});
    if(f.failProjects)return {output:{ok:false,error:{code:'network',message:'虚构关联读取失败'}}};
  }
  if(name==='hours.submit')throw Error('Fixture forbids submission');
  const response=await fetch('/bridge',{method:'POST',body:JSON.stringify({name,input})});
  const output=await response.json();
  if(output.ok&&name==='git.projects.load')output.value.projects.forEach(p=>p.enabled=f.enabled);
  if(output.ok&&name==='day.read'){
    output.value.existing=f.existing;
    output.value.attendance.punches=f.times.map(time=>({date:input.date,realDate:input.date,time,isNext:false,outFence:false}));
  }
  return {output};
}}};
window.app=new WorkbenchUI(document.getElementById('fixture-root'));
</script></html>`
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html) }
    if (path === '/bridge' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 131072) throw Error('Too large') }
      const { name, input } = JSON.parse(body)
      const handler = handlers.get(name)
      if (!handler) throw Error('Unexpected handler')
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify(await handler(input, {})))
    }
    if (!/^\/src\/[a-zA-Z0-9/.-]+$/.test(path) || path.includes('..')) throw Error('Unknown path')
    const source = await readFile(new URL('..' + path, import.meta.url), 'utf8')
    res.setHeader('Content-Type', path.endsWith('.ts') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8')
    res.end(path.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'transform' }) : source)
  } catch { res.writeHead(400); res.end('{}') }
})
server.listen(18779, '127.0.0.1', () => console.log('http://127.0.0.1:18779'))
