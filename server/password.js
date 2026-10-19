// Password policy in the spirit of NIST 800-63B: favor length, block known-bad choices, skip arbitrary
// "must contain a symbol" rules. Returns an error message, or null when the password is acceptable.
const COMMON = new Set(`password password1 password12 password123 passw0rd p@ssw0rd p@ssword qwerty qwerty123 qwertyuiop
qwertyuiop123 asdfghjkl asdfghjkl123 zxcvbnm 1q2w3e4r 1q2w3e4r5t 1qaz2wsx qazwsxedc iloveyou iloveyou1 letmein letmein123
welcome welcome1 welcome123 admin admin123 administrator login login123 abc123 abcd1234 abcdefgh 123456 1234567 12345678
123456789 1234567890 0987654321 111111 000000 123123 123321 654321 monkey dragon master sunshine princess football baseball
superman batman trustno1 shadow michael jennifer hunter changeme changeme123 default guest test test123 testing123 secret
secret123 whatever freedom starwars pokemon google facebook instagram whatsapp india india123 bollywood krishna ganesh
shiva jaishreeram bharat delhi mumbai qrforge qrcode qrcode123`.split(/\s+/));

const SEQUENCES = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiopasdfghjklzxcvbnm'];

export function validatePassword(pw, { email = '', name = '' } = {}) {
  if (typeof pw !== 'string') return 'Enter a password.';
  if (pw.length < 10) return 'Use at least 10 characters. A few random words make a strong, memorable password.';
  if (pw.length > 200) return 'That password is too long (200 characters maximum).';

  const lower = pw.toLowerCase();
  const stripped = lower.replace(/[\d\W_]+$/g, '');                  // "Password!!2026" -> "password"
  if (COMMON.has(lower) || COMMON.has(stripped)) return 'That password is too common. Choose something less guessable.';
  if (new Set(lower).size < 5) return 'That password has too few different characters.';
  if (SEQUENCES.some((s) => s.includes(lower))) return 'That password is a simple sequence. Choose something less predictable.';

  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (local.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(local)) return 'Your password should not contain your email address.';
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) return 'Your password should not contain your name.';
  }
  return null;
}
