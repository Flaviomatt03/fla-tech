import { load, save } from './storage.js';

const KEY = 'hp.settings';

// Valori predefiniti opzionali: puoi committare qui il Client ID Spotify (non è un segreto).
// La chiave YouTube è meglio inserirla dalle Impostazioni dell'app (resta solo sul telefono).
const DEFAULTS = {
  spotifyClientId: '',
  youtubeApiKey: '',
  spotifyDeviceId: '',
  spotifyDeviceName: '',
  youtubeMusicOnly: true,
  audioServer: '',
};

export const settings = { ...DEFAULTS, ...load(KEY, {}) };

export function updateSettings(patch) {
  Object.assign(settings, patch);
  save(KEY, settings);
}

/** Redirect URI da registrare nella Spotify Developer Dashboard. */
export function redirectUri() {
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, '');
}
