import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const PODCAST_SKILL_VERSION='2026-10-22.1';
let root=process.cwd();
export function setPodcastSkillRoot(value:string){root=value;}
export function podcastSkill(){
 const directory=path.join(root,'skills','podcast-producer');
 const instructions=readFileSync(path.join(directory,'SKILL.md'),'utf8');
 const rules=readFileSync(path.join(directory,'references','editorial.md'),'utf8');
 const publicationRules=readFileSync(path.join(directory,'references','publication.md'),'utf8');
 return {name:'podcast-producer',version:PODCAST_SKILL_VERSION,sha256:createHash('sha256').update(instructions+'\n'+rules+'\n'+publicationRules).digest('hex'),instructions,rules,publicationRules};
}

export interface PublicationStyle {rules:string;voiceHash?:string;voiceScope?:'project'|'local';}
export function publicationStyle(projectRoot?:string):PublicationStyle {
 const rules=podcastSkill().publicationRules;
 const locations:[string,'project'|'local'][]=[];
 if(projectRoot)locations.push([path.join(projectRoot,'publication-voice.md'),'project']);
 locations.push([path.join(root,'.podcast-drafts','publication-voice.md'),'local']);
 for(const [file,scope] of locations){
  let voice:string;
  try{voice=readFileSync(file,'utf8').trim();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  if(!voice)continue;
  if(voice.length>18000)throw Error('个人文风档案过长，请保留有依据的规则与少量例句');
  return {rules:rules+'\n\n## 本次作者选用的个人文风档案\n仅提供表达参照。档案里的故事、事实和立场不能充当本期正文素材。\n'+voice,voiceHash:createHash('sha256').update(voice).digest('hex'),voiceScope:scope};
 }
 return {rules};
}
