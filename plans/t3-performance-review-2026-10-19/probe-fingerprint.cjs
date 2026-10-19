const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{execFileSync}=require('node:child_process');
(async()=>{
 const root=path.resolve('apps/mobile');
 const {resolveExpoAutolinkingCliPath}=require('@expo/fingerprint/build/ExpoResolver');
 const cli=resolveExpoAutolinkingCliPath(root);
 const config=JSON.parse(execFileSync('node',[cli,'resolve','-p','android','--json'],{cwd:root,encoding:'utf8'}));
 const options={platforms:['android'],nativeModuleSourceType:'dir',sourceSkips:0};
 const filename=require.resolve('@expo/fingerprint/build/sourcer/Expo');
 const source=fs.readFileSync(filename,'utf8');
 const originalSources=await require(filename).getExpoAutolinkingAndroidSourcesAsync(root,options,'58.0.11');
 const marker='for (const plugin of module1.plugins){';
 if(!source.includes(marker))throw new Error('Expected plugin loop missing');
 const patchedSource=source.replace(marker,marker+"\n if (typeof plugin.sourceDir !== 'string') continue;");
 const probeModule=new Module(filename,module);probeModule.filename=filename;probeModule.paths=Module._nodeModulePaths(path.dirname(filename));probeModule._compile(patchedSource,filename);
 const guardedSources=await probeModule.exports.getExpoAutolinkingAndroidSourcesAsync(root,options,'58.0.11');
 const result={note:'Read-only source enumeration; patched library exists only in this Node process. No native build, full fingerprint hash, EAS command or package change.',fingerprintVersion:require('@expo/fingerprint/package.json').version,autolinkingVersion:require('expo-modules-autolinking/package.json').version,moduleCount:config.modules.length,originalSourceCount:originalSources.length,guardedSourceCount:guardedSources.length,guardedNativeSourceCount:guardedSources.filter(s=>s.type==='dir').length,missingPluginSourceDir:config.modules.flatMap(m=>(m.plugins||[]).filter(p=>typeof p.sourceDir!=='string').map(p=>({packageName:m.packageName,plugin:p})))};
 fs.writeFileSync('plans/t3-performance-review-2026-10-19/fingerprint-probe-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
