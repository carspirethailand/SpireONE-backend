/* No photo, filename, car nationality or model guess can establish that a cover
   is owner-removable. No removal procedure is approved by this module. */
export function coverGuidance({items=[],targetPart='',viewAttempts=0,lang='th'}={}) {
  const en=lang==='en',cover=items.some(p=>p.part==='engine_cover'),visible=items.some(p=>p.part===targetPart);
  let action='leave_on',message;
  if(!targetPart||visible)message=en?'No cover removal is needed for this view or question. Keep the cover fitted.':'ยังไม่จำเป็นต้องถอดฝาครอบสำหรับภาพหรือคำถามนี้ ให้คงฝาไว้ครับ';
  else if(!cover||viewAttempts<1){action='change_view';message=en?'The requested part is not clearly visible. Try a side angle, better light or a closer view without touching or removing anything.':'ยังไม่เห็นจุดที่ถามชัด ลองถ่ายจากด้านข้าง เพิ่มแสง หรือเข้าใกล้ด้วยกล้อง โดยไม่แตะหรือถอดชิ้นส่วนครับ';}
  else {action='manual_required';message=en?'A cover limits this view, but that does not prove the requested part is underneath it. Access may require the exact vehicle/engine manufacturer procedure and a qualified mechanic. Do not pull, unbolt or open it just to complete a scan.':'ฝาครอบบังภาพบางส่วน แต่ยังยืนยันไม่ได้ว่าจุดที่ถามอยู่ใต้ฝานี้ หากจำเป็นต้องเข้าถึง ต้องตรวจคู่มือผู้ผลิตที่ตรงรุ่นและเครื่องยนต์ หรือให้ช่างตรวจ ไม่ดึง คลายสกรู หรือเปิดเพียงเพื่อสแกนให้ครบครับ';}
  return {action,message,coverVisible:cover,targetVisible:!!targetPart&&visible,maySuggestRemoval:false,manualRequired:action==='manual_required'};
}
