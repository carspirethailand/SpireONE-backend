/* Authentication establishes membership. The client may choose a side only when it owns both sides. */
export function jobActor({isCustomer,isTech,staff},required,as){
  if(required==='admin'&&staff)return 'admin';
  if(isCustomer&&isTech){
    if(required==='tech')return 'technician';
    if(required==='customer')return 'customer';
    if(['customer','technician'].includes(as))return as;
    throw Object.assign(Error('เลือกว่าดำเนินการในฐานะลูกค้าหรือช่าง'),{status:400});
  }
  return isTech?'technician':isCustomer?'customer':staff?'admin':'unknown';
}
export function cancellationActor(history){
  let rows=history;try{if(typeof rows==='string')rows=JSON.parse(rows)}catch{return 'unknown'}
  const event=Array.isArray(rows)?rows.filter(x=>x?.status==='cancelled').at(-1):null;
  return ['customer','technician','admin','system'].includes(event?.by)?event.by:'unknown';
}
