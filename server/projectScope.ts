import path from 'node:path';
export function projectRoot(root:string,id:unknown):string {
 if(id===undefined||id==='')return path.join(root,'.podcast-drafts');
 if(typeof id!=='string'||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(id))throw Error('无效项目编号');
 return path.join(root,'.podcast-drafts','projects',id);
}
