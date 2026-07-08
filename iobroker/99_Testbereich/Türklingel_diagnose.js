// TEMPORÄRES DIAGNOSE-SKRIPT – separat als eigenes Skript anlegen und einmal klingeln lassen
on({id: 'hm-rpc.0.0026E0C998D1F2.1.STATE', change: 'ne'}, function (obj) {
    log(`DIAGNOSE: val=${JSON.stringify(obj.state.val)} (Typ: ${typeof obj.state.val}), ` +
        `ack=${obj.state.val === obj.state.val ? obj.state.ack : '?'}, ` +
        `alterWert=${JSON.stringify(obj.oldState?.val)}`, 'warn');
});

log(`Aktueller Wert: ${JSON.stringify(getState('hm-rpc.0.0026E0C998D1F2.1.STATE'))}`, 'warn');