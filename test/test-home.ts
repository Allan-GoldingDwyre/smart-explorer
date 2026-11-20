// Isole le dossier de données (SMART_EXPLORER_HOME) dans un répertoire
// temporaire : à importer en PREMIER dans chaque fichier de test qui touche
// au store, pour ne jamais écrire dans le vrai ~/.local/share/smart-explorer.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.SMART_EXPLORER_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), 'smart-explorer-home-'),
);
