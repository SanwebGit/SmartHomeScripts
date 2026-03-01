// 'child_process' wird benötigt, um exec zu verwenden
const { exec } = require('child_process');

exec('ls -l', function(err, stdout, stderr) {
    if (err) {
        // Angenommen, 'log' ist eine definierte Funktion wie console.log
        console.log(err);
        return;
    }
    // Hier kannst du mit 'stdout' oder 'stderr' weiterarbeiten
    console.log(`stdout: ${stdout}`);
    console.log(`stderr: ${stderr}`);
});