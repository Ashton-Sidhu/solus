#!/usr/bin/env bash
set -euo pipefail
# Run from the Solus repository root. All SQLite databases are in memory.
bun --no-env-file -e '
import {applyCommentCommand as apply} from "./packages/contracts/src/comment-commands.ts";
import {reconcileComments} from "./packages/workspace-ui/src/contexts/works/comment-sync.ts";
let n=0;
function ok(x){if(!x)throw Error("assertion "+n);n++}
const actor={by:{kind:"system"},canModerate:true,now:10};
let rows=apply([],{kind:"add",comment:{id:"z",selectedText:"q",comment:"one"}},actor);
rows=apply(rows,{kind:"add",comment:{id:"a",selectedText:"r",comment:"two"}},{...actor,now:1});
ok(rows.map(x=>x.id).join()==="z,a");
const replied=apply(rows,{kind:"reply",commentId:"z",reply:{id:"r1",text:"yes"}},actor);
ok(replied[0].replies[0].id==="r1");
ok(replied[1]===rows[1]);
let conflict=false;
try {
  apply(replied,{kind:"reply",commentId:"z",reply:{id:"r1",text:"yes"}},actor)
} catch(e) { conflict=e.code==="CONFLICT" }
ok(conflict);
const all=apply(replied,{kind:"resolve-open"},actor);
ok(all.every(x=>x.resolvedAt===10));
const again=apply(all,{kind:"resolve-open"},{...actor,now:20});
ok(again[0]===all[0]&&again[1]===all[1]);
const target=[...rows];
reconcileComments(target,replied);
ok(target[0]===rows[0]);
ok(target[0].replies[0].id==="r1");
console.log({passed:n,failed:0,bun:Bun.version});
'
