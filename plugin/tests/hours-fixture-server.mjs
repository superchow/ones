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
window.fixture={times:['18:30','09:00'],existing:30,failProjects:false,holdProjects:false,enabled:true,aiReady:false,aiState:'sent'};
window.orca={on:()=>({dispose(){}}),host:{call:async(_method,{name,input={}})=>{
  calls.push({name,input}); const f=window.fixture;
  if(name==='preferences.load')return {output:{ok:true,value:{version:1,accounts:{ones:'',coho:''},tab:'hours',git:{emails:'',allAuthors:false},teams:{},profiles:{}}}};
  if(name==='preferences.update')return {output:{ok:true,value:{saved:true}}};
  if(name==='hours.aiStart'){
    if(f.holdAI)await new Promise(resolve=>{window.releaseAI=resolve});
    return {output:{ok:true,value:{id:'a'.repeat(64),date:document.getElementById('业务日期（YYYY-MM-DD）')?.value||'2026-11-11',state:f.aiState,sessionId:'fictional-session'}}};
  }
  if(name==='tasks.projects')return {output:{ok:true,value:[{id:'project',name:'测试项目'},{id:'other-project',name:'另一个项目'}]}};
  if(name==='tasks.createOptions')return {output:{ok:true,value:{project:{id:input.projectId,name:input.projectId==='project'?'测试项目':'另一个项目'},issueType:{id:'task',name:'任务'},iterations:[{id:input.projectId+'-sprint',name:'迭代一'},{id:input.projectId+'-next',name:'迭代二'}],sprintRequired:true,fields:[{id:'due',name:'截止日期',type:5,required:true,value:'2026-11-11',options:[]}],stamp:'fixture'}}};
  if(name==='hours.aiResult'){
    const tasks=[{id:'task-fixture',number:89,name:'登录会话恢复',project:{id:'project',name:'测试项目'},issueType:{id:'task',name:'任务'},status:{id:'open',name:'进行中'}},{id:'bug-fixture',number:88,name:'虚构缺陷',project:{id:'project',name:'测试项目'},issueType:{id:'bug',name:'Bug'},status:{id:'open',name:'进行中'}}];
    const allocation={taskId:'task-fixture',start:'09:00',minutes:450,description:'修复登录会话恢复'};
    if(f.aiNewTask){allocation.taskId='';allocation.newTask={key:'stable-fixture',title:'登录会话恢复',projectId:'project',sprintId:'project-sprint',fields:{}}}
    return {output:{ok:true,value:f.aiReady?{ready:true,allocations:[allocation],tasks,projects:[{id:'project',name:'测试项目',iterations:[]}],notes:'无编号提交涉及登录模块，建议关联登录会话恢复；时长待本人核对。'}:{ready:false}}};
  }
  if(name==='git.projects.load'){
    if(f.holdProjects)await new Promise(resolve=>{window.releaseProjects=resolve});
    if(f.failProjects)return {output:{ok:false,error:{code:'network',message:'虚构关联读取失败'}}};
  }
  if(name==='hours.submit'){
    if(f.submitError)return {output:{ok:false,error:{code:f.submitError,message:'虚构提交校验失败'}}};
    throw Error('Fixture forbids submission');
  }
  const response=await fetch('/bridge',{method:'POST',body:JSON.stringify({name,input})});
  const output=await response.json();
  if(output.ok&&name==='git.read'&&f.aiUnnumbered){output.value.commits.push({...output.value.commits[0],hash:'b'.repeat(40),subject:'修复登录会话恢复（无编号）'});output.value.repositories[0].count=2}
  if(output.ok&&name==='hours.preview')output.value.rows=output.value.rows.map(r=>({...r,taskName:r.newTask?'将新建任务：'+r.newTask.title:r.taskId,creationDetails:r.newTask?['项目：'+r.newTask.projectId,'迭代：'+r.newTask.sprintId]:[]}));
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
