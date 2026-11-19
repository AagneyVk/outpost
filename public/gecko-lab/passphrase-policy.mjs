// Keep the requested eight-character option for existing users, while making
// longer passphrases possible for better resistance to offline guessing.
export function validExportPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length > 1024) return false;
  if (passphrase.length === 8) return /^(?=.*[0-9])(?=.*[\p{P}\p{S}])\S{8}$/u.test(passphrase);
  return passphrase.length >= 16 && /\S/u.test(passphrase);
}
