/* Google Places RoutingSummary. Off unless the owner explicitly enables the
   higher-billing SKU AND the caller consents to using the current routing origin.
   No route inference from straight-line distance, no origin storage or logging. */
export const routingEnabled=env=>env.SHOP_GOOGLE_ROUTES_ENABLED==='1';
export function routingRequest(env,input){
  if(!routingEnabled(env)||input.routeLocationConsent!==true||!input.location)return null;
  return {origin:{latitude:input.location.lat,longitude:input.location.lng},travelMode:'DRIVE',routingPreference:'TRAFFIC_UNAWARE',routeModifiers:{avoidFerries:true}};
}
export function routeFor(summary,airDistanceM){
  if(!Array.isArray(summary?.legs)||summary.legs.length!==1)return null;
  const leg=summary.legs[0],meters=leg?.distanceMeters,duration=leg?.duration;
  const m=typeof duration==='string'&&/^(?:0|[1-9]\d*)(?:\.\d{1,9})?s$/.test(duration)?Number(duration.slice(0,-1)):NaN;
  if(!Number.isInteger(meters)||meters<0||meters>2000000||!Number.isFinite(m)||m<0||m>604800||meters>500&&m===0)return null;
  // Snapping a GPS point to a road may shave a little off a very short route.
  // An implausibly shorter route is not usable evidence for road proximity.
  if(Number.isFinite(airDistanceM)&&meters+300<airDistanceM)return null;
  return {distanceM:meters,durationS:Math.ceil(m),mode:'DRIVE',traffic:'unaware',detour:Number.isFinite(airDistanceM)&&airDistanceM>=100&&meters-airDistanceM>=2000&&meters/airDistanceM>=1.8};
}
export function routeOrder(places){
  return places.slice().sort((a,b)=>{
    const x=a.driving,y=b.driving;
    if(x&&y)return x.durationS-y.durationS||x.distanceM-y.distanceM||String(a.id).localeCompare(String(b.id));
    if(x||y)return x?-1:1;
    return (a.distanceM??Infinity)-(b.distanceM??Infinity)||String(a.id).localeCompare(String(b.id));
  });
}
export function routingState(places,requested,enabled){
  const n=places.filter(p=>p.driving).length;
  return {status:!enabled?'disabled':!requested?'consent_required':n===0?'unavailable':n===places.length?'available':'partial',ranking:n?'driving_time':'straight_line',traffic:n?'unaware':null};
}
