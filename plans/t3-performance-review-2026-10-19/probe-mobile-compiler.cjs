const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const root = process.cwd();
const mobile = path.join(root, 'apps/mobile');
const out = path.join(root, 'plans/t3-performance-review-2026-10-19');
const preset = require.resolve('babel-preset-expo');
const files = process.argv.slice(2);
const selected = files[0] === '--manifest' ? JSON.parse(fs.readFileSync(files[1], 'utf8')) : files.length ? files : [
  'src/features/threads/ThreadComposer.tsx',
  'src/features/threads/ThreadFeed.tsx',
  'src/features/threads/ThreadNavigationSidebar.tsx',
  'src/features/threads/ThreadDetailScreen.tsx',
  'src/features/layout/AdaptiveWorkspaceLayout.tsx',
  'src/features/prs/detail/use-pull-request-action.ts',
];
const caller = {name:'metro',bundler:'metro',platform:'ios',isDev:false,isServer:false,isNodeModule:false,isHMREnabled:false,projectRoot:mobile,engine:'hermes',supportsStaticESM:false};
const result=[];
for (const file of selected) {
  const filename=path.join(mobile,file), source=fs.readFileSync(filename,'utf8');
  const names=new Map();
  const ast=parser.parse(source,{sourceType:'module',plugins:['typescript','jsx']});
  traverse(ast,{Function(p){ const n=p.node; let name=n.id?.name; if(!name && p.parentPath.isVariableDeclarator()) name=p.parentPath.node.id.name; if(!name && p.parentPath.isCallExpression() && p.parentPath.parentPath.isVariableDeclarator()) name=p.parentPath.parentPath.node.id.name; names.set(n.loc.start.line+':'+n.loc.start.column,name||'<anonymous>'); }});
  for(const enabled of [false,true]) {
    const events=[];
    const logger={logEvent(_filename,event) { const {kind,fnLoc,fnName,reason,detail}=event; events.push({kind,name:fnName || (fnLoc && names.get(fnLoc.start.line+':'+fnLoc.start.column)),line:fnLoc?.start.line,reason:reason || detail?.reason,description:detail?.description,category:detail?.category,diagnosticLine:(detail?.primaryLocation?.() || detail?.loc)?.start?.line, detailLines:detail?.options?.details?.filter(d=>d.loc).map(d=>({line:d.loc.start.line,message:d.message})),memoSlots:event.memoSlots}); }};
    const before=performance.now();
    try {
      const transformed=babel.transformSync(source,{filename,cwd:mobile,root:mobile,configFile:false,babelrc:false,caller:{...caller,supportsReactCompiler:enabled},presets:[[preset,{'react-compiler':{logger}}]],sourceMaps:false,ast:false,compact:true});
      const row={file:'apps/mobile/'+file,enabled,ms:Math.round(performance.now()-before),compilerRuntime:transformed.code.includes('react/compiler-runtime'),events}; result.push(row);
      console.log(file,enabled?'enabled':'current',JSON.stringify(events.reduce((a,x)=>(a[x.kind]=(a[x.kind]||0)+1,a),{})),row.ms+'ms');
    } catch(error) { result.push({file:'apps/mobile/'+file,enabled,ms:Math.round(performance.now()-before),error:String(error),events}); console.log(file,enabled,'TRANSFORM ERROR',String(error).split('\n')[0]); }
  }
}
fs.writeFileSync(path.join(out,process.env.COMPILER_PROBE_OUT || 'compiler-probe-results.json'),JSON.stringify({createdAt:new Date().toISOString(),versions:{babel:require('@babel/core/package.json').version,expoPreset:require('babel-preset-expo/package.json').version,compiler:require('babel-plugin-react-compiler/package.json').version},caller,config:'Same Expo preset as current babel.config.js; logger only. Current caller supportsReactCompiler=false; enabled variant true. No files modified.',results:result},null,2)+'\n');
