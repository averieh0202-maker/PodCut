export interface AgentMaterial {name:string;duration:number;mime:string;asset:{id:string;bytes:number}}
export interface ProductionOptions {
 highlights:'none'|'choose'|'auto';highlightCount:number;
 musicMode:'keep'|'configure';opening?:AgentMaterial;transition?:AgentMaterial;ending?:AgentMaterial;
 openingLeadSec:number;openingDurationSec:number;openingScope:'highlights'|'duration';
 bedGainDb:number;transitionGainDb:number;endingGainDb:number;speechRate:number;
}
export const productionDefaults:ProductionOptions={highlights:'none',highlightCount:3,musicMode:'keep',openingLeadSec:3,openingDurationSec:30,openingScope:'highlights',bedGainDb:-18,transitionGainDb:-12,endingGainDb:-12,speechRate:1};
export function productionOptions(raw:any):ProductionOptions {
 const o={...productionDefaults,...raw};
 if(!['none','choose','auto'].includes(o.highlights)||!['keep','configure'].includes(o.musicMode)||!['highlights','duration'].includes(o.openingScope))throw Error('制作选项无效');
 for(const [key,min,max] of [['highlightCount',1,5],['openingLeadSec',0,30],['openingDurationSec',1,600],['bedGainDb',-40,0],['transitionGainDb',-40,6],['endingGainDb',-40,6],['speechRate',.5,2]] as const)if(!Number.isFinite(o[key])||o[key]<min||o[key]>max)throw Error('制作选项超出范围：'+key);
 if(!Number.isInteger(o.highlightCount))throw Error('精句数量必须为整数');
 for(const key of ['opening','transition','ending'] as const){const m=o[key];if(o.musicMode==='keep'){delete o[key];continue;}if(m && (typeof m.name!=='string'||m.name.length>200||!Number.isFinite(m.duration)||m.duration<=0||m.duration>600||!/^audio\/[a-z0-9.+-]+$/i.test(m.mime)||!m.asset||!/^[a-f0-9]{64}$/.test(m.asset.id)||!Number.isSafeInteger(m.asset.bytes)||m.asset.bytes<=0))throw Error('配乐素材无效');}
 return o;
}
