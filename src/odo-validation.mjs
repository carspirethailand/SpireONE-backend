const bad=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status})};
export function anchorInput(body,now=Date.now()){
  const value=body?.km,raw=String(value??'').trim();
  if((typeof value!=='number'&&!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw))||!raw)bad('bad_km','กรอกเลขหน้าปัดเป็นจำนวนเต็ม / Enter an integer dashboard reading');
  const km=typeof value==='number'?value:Number(raw.replace(/,/g,''));
  if(!Number.isInteger(km)||km<0||km>3000000)bad('bad_km','เลขไมล์อยู่นอกช่วง / Mileage out of range');
  const at=body.observedAt==null?now:Number(body.observedAt);
  if(!Number.isFinite(at)||at<Date.UTC(1990,0,1)||at>now+300000)bad('bad_date','เวลาของเลขไมล์ไม่ถูกต้อง / Invalid reading time');
  return {km,at:Math.min(at,now)};
}
export function anchorOrder({km,at},before,after,confirmJump=false){
  if(before&&km<before.km||after&&km>after.km)bad('mileage_order','เลขไมล์ไม่สอดคล้องกับประวัติ กรุณาตรวจวันที่และเลขหน้าปัด / Reading conflicts with the dated history',409);
  if(before&&!confirmJump){const days=Math.max(1,(at-before.observed_at)/86400000);if(km-before.km>Math.max(1500,days*1500))bad('mileage_jump','เลขไมล์เพิ่มสูงผิดปกติ กรุณาตรวจเลขหน้าปัดและยืนยันอีกครั้ง / Unusual increase; check the dashboard and confirm again',409)}
  return true;
}
