const fs=require('node:fs'),path=require('node:path');
const transformer=require('@expo/metro-config/babel-transformer');
const generate=require('@babel/generator').default;
(async()=>{
 const root=path.resolve('apps/mobile');
 const filename=path.join(root,'src/features/files/SourceFileSurface.tsx');
 const src=fs.readFileSync(filename,'utf8');
 const results=[];
 for(const enabled of [false,true]){
  const result=await transformer.transform({filename,src,options:{projectRoot:root,platform:'ios',dev:false,hot:false,minify:false,type:'module',enableBabelRCLookup:true,experimentalImportSupport:false,customTransformOptions:{reactCompiler:enabled,engine:'hermes'},inlineRequires:false,unstable_transformProfile:'hermes-stable'}});
  const code=generate(result.ast,{compact:true}).code;
  results.push({enabled,compilerRuntime:code.includes('react/compiler-runtime'),memoCacheCalls:(code.match(/\.c\)\(/g)||[]).length,codeBytes:Buffer.byteLength(code)});
 }
 const output={note:'Calls the installed Expo Metro Babel transformer directly with the actual local Babel config. Transform only; no Metro server, graph, bundling, build, source write or device run.',file:path.relative(process.cwd(),filename),results};fs.writeFileSync('plans/t3-performance-review-2026-10-19/expo-transformer-probe-results.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
