const fs=require('node:fs'),path=require('node:path');
const parser=require('@babel/parser'),traverse=require('@babel/traverse').default;
const base='apps/mobile/src',candidates=[];let fileCount=0,functionCount=0;
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name); if(entry.isDirectory()){visit(file);continue;} if(!/\.(ts|tsx)$/.test(file)||/\.(test|d)\.ts/.test(file))continue;
 const source=fs.readFileSync(file,'utf8'); let ast;try{ast=parser.parse(source,{sourceType:'module',plugins:['typescript','jsx']});}catch(error){throw new Error(file+':'+error.message);}
 fileCount++;
 traverse(ast,{Function(p){const n=p.node;let name=n.id?.name;if(!name&&p.parentPath.isVariableDeclarator())name=p.parentPath.node.id.name;if(!/^use[A-Z]/.test(name||''))return;functionCount++;let callsHook=false;
 p.traverse({Function(inner){inner.skip();},CallExpression(call){const c=call.node.callee;const name=c.type==='Identifier'?c.name:c.type==='MemberExpression'&&!c.computed&&c.property.type==='Identifier'?c.property.name:'';if(/^use([A-Z]|$)/.test(name))callsHook=true;}});
 if(!callsHook)candidates.push({file,line:n.loc.start.line,name,source:source.slice(n.start,n.end)});
 }});
}}
visit(base);const result={fileCount,functionCount,candidates};fs.writeFileSync('plans/t3-performance-review-2026-10-19/hook-name-probe-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
