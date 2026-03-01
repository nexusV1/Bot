const sqlite3 = require('sqlite3').verbose();
let db = null;
function init(dbPath) { db = new sqlite3.Database(dbPath, (err) => { if (err) console.error('[db_ext] Error:', err.message); }); }
function getAllRaffles() { return []; }
function saveAllRaffles(raffles) {}
function getAllRetos() { return []; }
function saveAllRetos(retos) {}
function getAllDestinos() { return {}; }
function saveAllDestinos(destinos) {}
function getAllTitulos() { return { root: { titulos: [] } }; }
function saveAllTitulos(titulos) {}
function getAllBosses() { return { root: { bosses: [], spawnHistory: {} } }; }
function saveAllBosses(bosses) {}
function getAllUsers() { return {}; }
function saveAllUsers(users) {}
function getAllClanWars() { return []; }
function saveClanWar(war) {}
function getAllRaids() { return {}; }
function saveAllRaids(raids) {}
function getAllClans() { return {}; }
function saveAllClans(clans) {}
function getAllFragmentos() { return { root: { fragmentos: [] } }; }
function saveAllFragmentos(fragmentos) {}
function getAllTournaments() { return {}; }
function saveAllTournaments(tournaments) {}
function getAllTrivias() { return {}; }
function saveAllTrivias(trivias) {}
function getAllExpeditions() { return {}; }
function saveAllExpeditions(expeditions) {}
function getAllSkilltrees() { return {}; }
function saveAllSkilltrees(skilltrees) {}
function getAllEnigmas() { return {}; }
function saveAllEnigmas(enigmas) {}
function getAllClanBosses() { return {}; }
function saveAllClanBosses(clanBosses) {}
function getAllEvents() { return {}; }
function saveAllEvents(events) {}
function getAllPropiedades() { return {}; }
function saveAllPropiedades(propiedades) {}
function getAllAlianzas() { return {}; }
function saveAllAlianzas(alianzas) {}
function getAllLeaderboards() { return {}; }
function saveAllLeaderboards(leaderboards) {}
function getAllCodes() { return {}; }
function saveAllCodes(codes) {}
function getAllAdmins() { return {}; }
function saveAllAdmins(admins) {}
function getAllStatsTienda() { return {}; }
function saveAllStatsTienda(stats) {}
function getAllUsuarios() { return {}; }
function closeDB() { if (db) db.close((err) => { if (err) console.error('[db_ext] Error:', err.message); }); }
module.exports = {
  init, getAllRaffles, saveAllRaffles, getAllRetos, saveAllRetos, getAllDestinos, saveAllDestinos,
  getAllTitulos, saveAllTitulos, getAllBosses, saveAllBosses, getAllUsers, saveAllUsers,
  getAllClanWars, saveClanWar, getAllRaids, saveAllRaids, getAllClans, saveAllClans,
  getAllFragmentos, saveAllFragmentos, getAllTournaments, saveAllTournaments, getAllTrivias,
  saveAllTrivias, getAllExpeditions, saveAllExpeditions, getAllSkilltrees, saveAllSkilltrees,
  getAllEnigmas, saveAllEnigmas, getAllClanBosses, saveAllClanBosses, getAllEvents, saveAllEvents,
  getAllPropiedades, saveAllPropiedades, getAllAlianzas, saveAllAlianzas, getAllLeaderboards,
  saveAllLeaderboards, getAllCodes, saveAllCodes, getAllAdmins, saveAllAdmins, getAllStatsTienda,
  saveAllStatsTienda, getAllUsuarios, closeDB
};
