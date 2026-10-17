/* Coverage inventory, NOT a verified layout database or a trained detector.
   Model names are garage context only. No year/engine/layout is inferred. */
export const ENGINE_REFERENCE_VERSION=1;
const inventories={
  Mitsubishi:'Mirage|Attrage|Lancer|Lancer EX|Triton|Pajero Sport|Outlander|Outlander PHEV|Xpander|Xpander Cross|Xforce|Space Wagon',
  Toyota:'Corolla|Corolla Altis|Corolla Cross|Camry|Vios|Yaris|Yaris Ativ|Yaris Cross|C-HR|Fortuner|Hilux|Hilux Revo|Hilux Champ|Innova|Innova Zenix|Veloz|Avanza|Sienta|Alphard|Vellfire|Majesty|Commuter|Granvia|Supra|GR86|GR Yaris|Prius|bZ4X|Land Cruiser|Land Cruiser Prado|Rush|Raize|Crown|Wish|86',
  Isuzu:'D-Max|D-Max V-Cross|D-Max Spark|MU-X|MU-7',
  Ford:'Ranger|Ranger Raptor|Everest|Mustang|Mustang Mach-E|Focus|Fiesta|EcoSport|Territory|Escape|Explorer',
  Honda:'City|City Hatchback|Civic|Civic Type R|Accord|Jazz|Fit|HR-V|CR-V|BR-V|WR-V|e:N1|Mobilio|Freed|Odyssey|StepWGN|Brio|Elysion|Stream'
};
export const ENGINE_MODEL_TARGETS=Object.freeze(Object.entries(inventories).flatMap(([make,names])=>names.split('|').map(model=>Object.freeze({make,model,status:'target_not_validated',generationVerified:false,layoutVerified:false}))));
export const ENGINE_REFERENCE_SOURCES=Object.freeze({
  mitsubishi_manuals:Object.freeze({url:'https://www.mitsubishi-motors.co.th/en/after-sales/promotion-and-other-services/owner-manual',scope:'Thailand manual index; not every historical model/engine'}),
  mitsubishi_phev:Object.freeze({url:'https://mitsubishi-motors.co.uk/wp-content/uploads/2021/06/20MY-Outlander-PHEV-Owners-Manual.pdf',scope:'2020 UK Outlander PHEV only; not a Thai layout map'}),
  toyota_hybrid:Object.freeze({url:'https://www.toyota.com/owners/warranty-owners-manuals/digital/article/camry-hv/2025/om06266u/ch06se030404/',scope:'2025 US Camry hybrid; not every Toyota coolant layout'}),
  toyota_ev:Object.freeze({url:'https://www.toyota.com/owners/warranty-owners-manuals/digital/article/bz/2026/om42j21u/ch07se030404/',scope:'2026 US bZ motor compartment; not every Thai bZ4X'}),
  isuzu_manuals:Object.freeze({url:'https://www.isuzu-tis.com/service/owners-manual',scope:'Thailand D-Max/MU-X manual index with separate editions; no MU-7 validation'}),
  ford_ranger:Object.freeze({url:'https://www.fordservicecontent.com/Ford_Content/Catalog/owner_information/P375_Ranger_English_2018_TKD_OM_ASEAN_JB3B19A321CKA.v1.pdf',scope:'2018 ASEAN Ranger; engine-specific diagrams, not all Fords'}),
  honda_models:Object.freeze({url:'https://www.honda.co.th/en/cataloghub',scope:'Thailand model/variant catalogue; not an engine-bay layout source'}),
  honda_hybrid_coolant:Object.freeze({url:'https://techinfo.honda.com/rjanisis/pubs/OM/AH/AT542525IOM/enu/details/131266047-386530.html',scope:'2025 US Civic hybrid high-voltage coolant; not all Honda tanks'})
});
const referenceRules={
  Mitsubishi:{sources:['mitsubishi_manuals','mitsubishi_phev'],caution:'Triton/Pajero Sport, older petrol models and HEV/PHEV variants have different layouts. A plastic cover is not the cylinder head beneath it. On PHEVs distinguish auxiliary battery/jump post from the unseen traction battery; never locate the latter from its model name.'},
  Toyota:{sources:['toyota_hybrid','toyota_ev'],caution:'Conventional, hybrid and electric variants are not interchangeable. Some hybrids have separate engine and power-control coolant circuits. A second reservoir is not automatically inverter coolant. An electric motor compartment must not be labelled with an invented oil cap, fuel rail or ignition coils.'},
  Isuzu:{sources:['isuzu_manuals'],caution:'D-Max/MU-X manuals have separate model years and EURO 4, EURO 5, MHEV and MAXFORCE editions. Do not assume emissions equipment, turbo arrangement or reservoir positions from D-Max badges. A diesel fuel filter/water separator is not a coolant or brake reservoir. Do not open its drain or primer.'},
  Ford:{sources:['ford_ranger'],caution:'Ranger manuals separate 2.0, 2.2 and 3.2 diesel layouts and right/left-hand-drive brake locations; these are not universal across generations. A brake/clutch reservoir may be shared. A fuel-filter water trap is not a coolant bottle. Ranger Raptor and Mustang/Mach-E names do not establish the photographed powertrain.'},
  Honda:{sources:['honda_models','honda_hybrid_coolant'],caution:'Turbo, naturally aspirated, e:HEV and electric variants differ. Some hybrid editions have a distinct high-voltage coolant tank; do not apply that identification to every Honda reservoir. An i-VTEC cover/logo is not visible coils or a cylinder count. Do not assign air-box, washer or brake identity from their usual position.'}
};
const norm=v=>typeof v==='string'&&v.length<=100?v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu,''):'';
const makeAliases=new Map(Object.keys(inventories).map(x=>[norm(x),x]));
for(const [alias,make]of [['มิตซูบิชิ','Mitsubishi'],['โตโยต้า','Toyota'],['อีซูซุ','Isuzu'],['ฟอร์ด','Ford'],['ฮอนด้า','Honda']])makeAliases.set(norm(alias),make);
const lookup=new Map(ENGINE_MODEL_TARGETS.map(x=>[norm(x.make)+':'+norm(x.model),x]));
for(const [make,alias,model]of [['Toyota','Altis','Corolla Altis'],['Toyota','Hilux Vigo','Hilux'],['Mitsubishi','L200','Triton'],['Mitsubishi','Montero Sport','Pajero Sport'],['Honda','Stepwagon','StepWGN'],['Isuzu','ดีแมคซ์','D-Max'],['Mitsubishi','ไทรทัน','Triton'],['Toyota','ฟอร์จูนเนอร์','Fortuner'],['Honda','ซีวิค','Civic']])lookup.set(norm(make)+':'+norm(alias),lookup.get(norm(make)+':'+norm(model)));
export function engineReferenceFor(car){
  if(!car||typeof car!=='object'||Array.isArray(car))return null;
  const make=makeAliases.get(norm(car.make||car.brand||car.name));if(!make)return null;
  const target=lookup.get(norm(make)+':'+norm(car.model));if(!target)return null;
  const r=referenceRules[make];
  return {version:ENGINE_REFERENCE_VERSION,make,model:target.model,status:target.status,generationVerified:false,layoutVerified:false,caution:r.caution,sourceIds:r.sources.slice()};
}
export function engineReferenceText(car){
  const r=engineReferenceFor(car);if(!r)return '';
  return 'SERVER REFERENCE (context only, NOT image evidence or a layout match): '+JSON.stringify(r)+'\nIf the photographed vehicle differs, ignore this reference. Confirm each component from visible markings/connections; never copy locations, infer hidden parts, specify fluids or recommend disassembly from this inventory.';
}
