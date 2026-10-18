// Additional document-backed fields. No fluids, pressures or service instructions are inferred.
export const DETAIL_NUM={cylinders:[1,16],valves:[2,64],gears:[1,12],top_speed_kmh:[30,500],zero100_s:[1,60],price_thb:[50000,1000000000],power_ps:[1,10000],power_kw:[1,8000]};
export const DETAIL_TEXT=['engine_code','induction','front_suspension','rear_suspension','front_brakes','rear_brakes','front_tire','rear_tire'];
export const DETAIL_FACTS={boot_l:[10,10000],turning_radius_m:[2,20],ground_clearance_mm:[30,1000],towing_braked_kg:[100,10000]};
export const DETAIL_WORDS={cylinders:['cylinder','cylinders','สูบ'],valves:['valve','valves','วาล์ว'],gears:['speed','speeds','gears','จังหวะ'],top_speed_kmh:['top speed','maximum speed','ความเร็วสูงสุด'],zero100_s:['0-100','0 to 100','0–100'],power_ps:['ps'],power_kw:['kw'],price_thb:['price','ราคา','baht','บาท','thb','฿'],boot_l:['boot','luggage','cargo','สัมภาระ'],turning_radius_m:['turning radius','วงเลี้ยว'],ground_clearance_mm:['ground clearance','ใต้ท้อง'],towing_braked_kg:['braked towing','towing capacity','ลากจูง']};

export function documentedPrice(car,records){
  // Historical list price is not current vehicle market value. Only primary Thai documents qualify.
  const prices=[];
  for(const r of records||[]){
    if(!r||!['ready','verified'].includes(r.status)||r.data?.schema!==2)continue;
    const query=r.data.query||{};
    if(String(r.year)!==String(car.year)||String(r.make).toLowerCase()!==String(car.make).toLowerCase()||String(r.model).toLowerCase()!==String(car.model).toLowerCase())continue;
    for(const v of r.data.variants||[]){
      const p=v.price_thb;if(!p||p.ok===false||!Number.isFinite(p.v)||p.v<50000||p.v>1e9)continue;
      const source=(r.sources||[]).find(s=>s.primary===true&&p.sourceIds?.includes(s.docId)&&/^https:\/\/(?:[^/]+\.)?[^/.]+\.co\.th\//.test(s.url||''));
      if(source)prices.push({value:p.v,source:source.url,at:r.updated_at,name:v.name,market:query.market});
    }
  }
  if(!prices.length)return null;
  // No implicit trim selection: use a conservative model ceiling, label the range, never a valuation.
  prices.sort((a,b)=>a.value-b.value);const top=prices.at(-1);
  return {make:car.make,model:car.model,year:String(car.year),valueThb:top.value,minThb:prices[0].value,source:top.source,asOf:new Date(top.at).toISOString().slice(0,10),kind:'documented-new-price'};
}
