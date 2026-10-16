/* Provisional visual-review notes from the user's ten supplied photographs.
   Not mechanic-verified labels, training data, predictions, or an accuracy test.
   Original photos and private paths are deliberately NOT stored in this repo. */
export const ENGINE_REFERENCE_CASES = [
  {id:'isuzu-front',visible:['engine_cover','battery','intake_duct'],doNotInfer:['ignition_coil','belt'],note:'Open surrounding hardware still coexists with a cosmetic cover. Do not generalise by region.'},
  {id:'bmw-covered-v8',visible:['engine_cover','washer_filler'],doNotInfer:['battery','battery_positive','ignition_coil','belt'],note:'Remote red jump post is not proof of a visible battery. No inferred clips or pulling procedure.'},
  {id:'mercedes-covered-inline',visible:['engine_cover','oil_cap','washer_filler'],doNotInfer:['ignition_coil','belt','battery'],note:'Accessible cap/filler does not require removing the large cover. Hidden engine hardware remains unknown.'},
  {id:'audi-filter-and-shroud',visible:['air_box','engine_cover'],doNotInfer:['battery','ignition_coil'],note:'Distinguish filter housing, electrical/battery enclosure and cosmetic cover; not every black box is a battery.'},
  {id:'porsche-large-cover',visible:['engine_cover','washer_filler'],doNotInfer:['ignition_coil','belt','battery'],note:'Large cover and visible peripheral filling points. Brand/size is not a reason to disassemble.'},
  {id:'honda-exposed-head',visible:['valve_cover','battery','air_box','alternator'],doNotInfer:['engine_cover'],note:'Bolted/sealed valve cover is a functional component, not a lift-off decoration.'},
  {id:'hyundai-two-dipsticks',visible:['valve_cover','battery','intake_manifold','dipstick_unknown'],doNotInfer:['engine_cover'],note:'Two differently coloured loops do not establish which is engine/transmission oil. Leads are not automatically individual coils.'},
  {id:'triton-angle',visible:['engine_cover','battery'],doNotInfer:['ignition_coil','belt'],note:'Oblique view and wet/dirty appearance do not establish faults. Plate in source must not be repeated or published.'},
  {id:'mustang-partial-cover',visible:['intake_duct','air_box','coolant_tank'],doNotInfer:['ignition_coil','belt','alternator'],note:'Visible intake runners and adjacent covers are distinct. Never extrapolate a removal sequence.'},
  {id:'toyota-covered-diesel',visible:['engine_cover','battery','air_box'],doNotInfer:['ignition_coil','belt'],note:'Cosmetic cover also occurs on a non-European vehicle; low box count does not justify removal.'}
];
