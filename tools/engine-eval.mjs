/* Offline evaluation only. Never uploads images, trains weights, reads secrets,
   or turns a file's reviewer flag into an authenticated expert certification. */
import {ENGINE_SCANNABLE_PARTS,ENGINE_PARTS,partInfo} from '../src/engine-bay.mjs';
import {ENGINE_MODEL_TARGETS,engineReferenceFor} from '../src/engine-references.mjs';
const known=new Set(ENGINE_SCANNABLE_PARTS);
const fluids=new Set(['brake_reservoir','clutch_reservoir','coolant_tank','inverter_coolant','power_steering','fuel_water_separator','fuel_primer']);
const electrical=new Set([...Object.keys(ENGINE_PARTS).filter(id=>partInfo(id).hazard==='high_voltage'),'battery_positive','battery_negative','jump_terminal']);
const slug=x=>typeof x==='string'&&x.length<=64&&/^[a-z0-9][a-z0-9._-]*$/i.test(x);
const validBox=b=>Array.isArray(b)&&b.length===4&&b.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1000)&&b[2]>b[0]&&b[3]>b[1];
export function boxIoU(a,b){
  if(!validBox(a)||!validBox(b))return 0;
  const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return intersection/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection||1);
}
// Maximum-cardinality bipartite matching, then prefer the larger overlaps.
// One predicted rectangle cannot satisfy two ground-truth instances.
function matchBoxes(labels,predictions,threshold){
  const edges=predictions.map(p=>labels.map((l,i)=>({i,iou:p.part===l.part?boxIoU(p.box,l.box):0})).filter(x=>x.iou>=threshold).sort((a,b)=>b.iou-a.iou));
  const owners=new Map();
  function assign(p,seen){for(const {i}of edges[p]){if(seen.has(i))continue;seen.add(i);if(!owners.has(i)||assign(owners.get(i),seen)){owners.set(i,p);return true;}}return false;}
  for(let p=0;p<predictions.length;p++)assign(p,new Set());
  return [...owners].map(([label,prediction])=>({label,prediction,iou:boxIoU(labels[label].box,predictions[prediction].box)}));
}
const ratio=(n,d)=>d?n/d:null;
export function evaluateEngineDataset(manifest,{iouThreshold=.5}={}){
  if(!manifest||manifest.schemaVersion!==1||!Array.isArray(manifest.cases)||manifest.cases.length>5000)throw Error('Invalid bounded evaluation manifest');
  if(typeof iouThreshold!=='number'||!Number.isFinite(iouThreshold)||iouThreshold<=0||iouThreshold>1)throw Error('Invalid IoU threshold');
  const cases=manifest.cases,ids=new Set(),developmentGroups=new Set();
  for(const c of cases){
    if(!c||!slug(c.id)||ids.has(c.id)||!slug(c.vehicleGroup)||!['development','holdout'].includes(c.split)||!Array.isArray(c.labels)||c.labels.length>120)throw Error('Invalid or duplicate evaluation case');
    ids.add(c.id);if(c.split==='development')developmentGroups.add(c.vehicleGroup);
    for(const l of c.labels)if(!l||!known.has(l.part)||!validBox(l.box))throw Error('Invalid visible ground-truth annotation');
    if(c.prediction?.items!==undefined&&(!Array.isArray(c.prediction.items)||c.prediction.items.length>120))throw Error('Invalid bounded predictions');
  }
  const counts={totalCases:cases.length,eligibleCases:0,excludedUnreviewed:0,excludedDevelopment:0,excludedVehicleLeakage:0,failedRequests:0,invalidPredictions:0,truePositives:0,falsePositives:0,falseNegatives:0,trueNegativeImages:0,dangerousConfusions:0};
  const models=new Set(),groups=new Set(),makeGroups=new Map(),byClass={};let iouSum=0;
  for(const c of cases){
    if(c.split!=='holdout'){counts.excludedDevelopment++;continue;}
    if(c.review?.status!=='approved'||c.review?.role!=='mechanic'){counts.excludedUnreviewed++;continue;}
    if(developmentGroups.has(c.vehicleGroup)){counts.excludedVehicleLeakage++;continue;}
    counts.eligibleCases++;groups.add(c.vehicleGroup);
    const target=engineReferenceFor(c.vehicle);if(target){models.add(target.make+':'+target.model);if(!makeGroups.has(target.make))makeGroups.set(target.make,new Set());makeGroups.get(target.make).add(c.vehicleGroup);}
    const success=c.prediction?.status==='ok'&&Array.isArray(c.prediction.items);
    if(!success)counts.failedRequests++;
    const predictions=success?c.prediction.items:[],valid=predictions.filter(p=>p&&known.has(p.part)&&validBox(p.box)),invalid=predictions.length-valid.length;
    counts.invalidPredictions+=invalid;counts.falsePositives+=invalid;
    const matches=matchBoxes(c.labels,valid,iouThreshold),matchedLabels=new Set(matches.map(x=>x.label)),matchedPreds=new Set(matches.map(x=>x.prediction));
    counts.truePositives+=matches.length;counts.falseNegatives+=c.labels.length-matches.length;counts.falsePositives+=valid.length-matches.length;
    iouSum+=matches.reduce((n,x)=>n+x.iou,0);
    if(success&&!c.labels.length&&!predictions.length)counts.trueNegativeImages++;
    const stat=part=>byClass[part]??=( {truePositives:0,falsePositives:0,falseNegatives:0} );
    c.labels.forEach((l,i)=>{stat(l.part)[matchedLabels.has(i)?'truePositives':'falseNegatives']++;});
    valid.forEach((p,i)=>{if(!matchedPreds.has(i)){stat(p.part).falsePositives++;if(p.part!=='reservoir_unknown'&&p.part!=='hose_unknown'&&c.labels.some(l=>l.part!==p.part&&boxIoU(l.box,p.box)>=iouThreshold&&(fluids.has(l.part)||fluids.has(p.part)||electrical.has(l.part)||electrical.has(p.part))))counts.dangerousConfusions++;}});
  }
  const coverage=Object.fromEntries(['Mitsubishi','Toyota','Isuzu','Ford','Honda'].map(make=>[make,{inventoriedModels:ENGINE_MODEL_TARGETS.filter(x=>x.make===make).length,representedModels:[...models].filter(x=>x.startsWith(make+':')).length,independentVehicleGroups:makeGroups.get(make)?.size||0}]));
  return {schemaVersion:1,status:counts.eligibleCases?'evaluated_not_certified':'no_independent_evaluation',releaseDecision:'human_review_required',iouThreshold,...counts,precision:ratio(counts.truePositives,counts.truePositives+counts.falsePositives),recall:ratio(counts.truePositives,counts.truePositives+counts.falseNegatives),meanMatchedIoU:ratio(iouSum,counts.truePositives),successfulRequestRate:ratio(counts.eligibleCases-counts.failedRequests,counts.eligibleCases),independentVehicleGroups:groups.size,inventoriedModelsRepresented:models.size,coverage,byClass,limitations:['Reviewer flags are caller-supplied, not an authenticated certification.','A represented model does not validate all its generations, engines or variants.','No model weights are trained by this evaluation.']};
}
const main=await import('node:url').then(({pathToFileURL})=>process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href);
if(main){
  try{
    if(process.argv.length!==3)throw Error('Use: node tools/engine-eval.mjs <manifest.json>');
    const {stat,readFile}=await import('node:fs/promises'),file=process.argv[2];if((await stat(file)).size>5_000_000)throw Error('Manifest exceeds 5 MB');
    console.log(JSON.stringify(evaluateEngineDataset(JSON.parse(await readFile(file,'utf8'))),null,2));
  }catch{console.error('Evaluation failed: provide one valid bounded manifest. No image or raw model content was logged.');process.exitCode=1;}
}
