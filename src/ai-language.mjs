const names=Object.freeze({th:'Thai',en:'English',zh:'Simplified Chinese',ja:'Japanese',ko:'Korean',id:'Indonesian',vi:'Vietnamese',ms:'Malay',de:'German',fr:'French',es:'Spanish',pt:'Portuguese'});
export const aiLocale=value=>Object.hasOwn(names,value)?value:'th';
export function languageRule(value,{voice=false}={}){
  return '\nRespond in '+names[aiLocale(value)]+' by default (headings and tool narration too). Follow an explicit language request or the latest substantive '+(voice?'spoken utterance':'message')+'; not older turns. Do not infer a language from car brands, names, quotes, files, numbers or media. Override Thai-first defaults, never safety/authorization.\n';
}
