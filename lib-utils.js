function obtenerRangoClasificacion(poder) {
  const classes = [
    { name: 'Callejero', min: 0, max: 499 },
    { name: 'Iniciado', min: 500, max: 999 },
    { name: 'Luchador', min: 1000, max: 4999 },
    { name: 'Héroe', min: 5000, max: 14999 },
    { name: 'Campeón', min: 15000, max: 29999 },
    { name: 'Continental', min: 30000, max: 74999 },
    { name: 'Planetario', min: 75000, max: 149999 },
    { name: 'Estelar', min: 150000, max: 299999 },
    { name: 'Universal', min: 300000, max: 599999 },
    { name: 'Infinity', min: 600000, max: 999999 },
    { name: 'Celestial', min: 1000000, max: 1999999 },
    { name: 'Eterno', min: 2000000, max: 4999999 },
    { name: 'Inmortal', min: 5000000, max: 9999999 },
    { name: 'Divino', min: 10000000, max: 24999999 },
    { name: 'Ancestral', min: 25000000, max: 49999999 },
    { name: 'Legendario', min: 50000000, max: 99999999 },
    { name: 'Omega', min: 100000000, max: 249999999 },
    { name: 'Primordial', min: 250000000, max: 399999999 },
    { name: 'Galáctico', min: 400000000, max: 599999999 },
    { name: 'Eterno Absoluto', min: 600000000, max: Infinity }
  ];

  let clase = classes[0].name;
  let claseObj = classes[0];
  for (const c of classes) {
    if (poder >= c.min && poder <= c.max) {
      clase = c.name;
      claseObj = c;
      break;
    }
  }

  let clasificacion = 'C';
  const span = (claseObj.max === Infinity) ? 1 : (claseObj.max - claseObj.min + 1);
  const relative = span === 0 ? 1 : ((Math.max(0, poder - claseObj.min)) / span);
  if (relative >= 0.9) clasificacion = 'S';
  else if (relative >= 0.6) clasificacion = 'A';
  else if (relative >= 0.25) clasificacion = 'B';
  else clasificacion = 'C';

  return { rango: clase, clase: clase, clasificacion: clasificacion };
}

function normalize(s){ return s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim(); }
function getWeaponMultiplierByItem(item){
  if (!item) return 1;
  const raw = (item.rareza || item.rarity || 'comun').toString();
  const rnorm = normalize(raw);
  const alias = {
    'comun': 'comun','comun ': 'comun',
    'especial': 'especial',
    'raro': 'raro',
    'epica': 'epico','epico':'epico',
    'legendaria':'legendario','legendario':'legendario',
    'mitica':'mitico','mitico':'mitico',
    'ultra mitica':'ultra','ultra mitico':'ultra','ultra':'ultra',
    'hecha por dioses':'dioses','dioses':'dioses'
  };
  const canonical = alias[rnorm] || rnorm;
  const multipliers = { 'comun':1.5,'especial':3.0,'raro':4.5,'epico':7.0,'legendario':12.0,'mitico':18.0,'ultra':28.0,'dioses':45.0 };
  return multipliers[canonical] || 1;
}

module.exports = { obtenerRangoClasificacion, getWeaponMultiplierByItem };
