// Tiny i18n layer. English lives in the HTML itself; other languages are overlays keyed by data-i18n.
const DICT = {
  hi: {
    'nav.how': 'यह कैसे काम करता है', 'nav.features': 'सुविधाएँ', 'nav.signin': 'साइन इन', 'nav.start': 'मुफ़्त शुरू करें',
    'hero.h1': 'मुफ़्त ऑनलाइन QR कोड जनरेटर', 'hero.sub': 'सेकंडों में अपना कस्टम QR कोड बनाएँ। उसे अपने ब्रांड लोगो से मिलाएँ और PNG, JPG, WebP, SVG या PDF में डाउनलोड करें।',
    'chip.free': 'मुफ़्त', 'chip.nosignup': 'साइन-अप नहीं', 'chip.brand': 'लोगो और ब्रांड रंग', 'chip.private': 'निजी, आपके ब्राउज़र में',
    'dyn.label': 'डायनामिक बनाएँ: बदलने योग्य लिंक और स्कैन एनालिटिक्स', 'dyn.create': 'डायनामिक कोड बनाएँ', 'dyn.dash': 'डैशबोर्ड खोलें',
    'bulk.type': 'हर पंक्ति है', 'bulk.csv': 'या CSV फ़ाइल अपलोड करें', 'bulk.fmt': 'फ़ॉर्मेट', 'bulk.go': 'ZIP बनाएँ',
    'tpl.title': 'टेम्पलेट', 'tpl.hint': 'एक शैली चुनें, फिर नीचे बदलाव करें।',
    'cust.title': 'कस्टमाइज़ करें', 'cust.fg': 'अग्रभूमि', 'cust.bg': 'पृष्ठभूमि', 'cust.dots': 'डॉट शैली', 'cust.corner': 'कोने की शैली',
    'cust.tstyle': 'रंग शैली', 'cust.c2': 'दूसरा रंग', 'cust.size': 'एक्सपोर्ट आकार',
    'logo.title': 'ब्रांड लोगो और ऑटो थीम', 'logo.hint': 'अपना लोगो (PNG, JPG, SVG या WebP) अपलोड करें या यहाँ खींचें।',
    'logo.size': 'लोगो आकार', 'logo.pad': 'पैडिंग', 'logo.clear': 'लोगो के पीछे के डॉट हटाएँ (स्कैन बेहतर)',
    'logo.match': 'QR थीम को लोगो के रंगों से मिलाएँ', 'logo.auto': '✨ लोगो से ऑटो-डिज़ाइन', 'logo.tint': 'पृष्ठभूमि को लोगो के रंग से हल्का रंगें',
    'logo.autohint': 'आपके लोगो के अनुसार आकार, रंग और हल्की पृष्ठभूमि चुनता है, फिर जाँचता है कि कोड स्कैन होता है।', 'logo.remove': 'लोगो हटाएँ',
    'frame.title': 'फ़्रेम और कॉल टू एक्शन', 'frame.style': 'फ़्रेम', 'frame.color': 'फ़्रेम रंग', 'frame.auto': 'QR जैसा', 'frame.text': 'लेबल टेक्स्ट',
    'kit.title': 'ब्रांड किट', 'kit.hint': 'अपना लोगो, रंग और शैली एक बार सहेजें, फिर हर कोड में दोबारा इस्तेमाल करें।', 'kit.name': 'किट का नाम', 'kit.save': 'किट सहेजें',
    'print.title': 'प्रिंट साइज़ जाँच', 'print.width': 'प्रिंट चौड़ाई (सेमी)', 'print.dist': 'स्कैन दूरी (मी)',
    'print.hint': 'हम सबसे छोटे डॉट का आकार और वह दूरी बताते हैं जहाँ से कोड स्कैन हो सकता है। PDF इसी प्रिंट चौड़ाई पर बनता है।',
    'act.undo': 'पूर्ववत', 'act.redo': 'फिर से', 'act.share': 'शेयर लिंक कॉपी करें', 'act.download': 'डाउनलोड', 'act.copy': 'इमेज कॉपी करें',
    'act.testscan': 'प्रिंट से पहले कोड को हमेशा स्कैन करके जाँचें।', 'recent.title': 'हाल के कोड',
    'how.title': 'QR कोड कैसे बनाएँ।', 'how.1t': '1. बनाएँ।', 'how.1d': 'प्रकार चुनें, जानकारी भरें, और आपका QR कोड तुरंत दिखेगा।',
    'how.2t': '2. अपना बनाएँ।', 'how.2d': 'अपना ब्रांड लोगो जोड़ें और रंग-आकार अपने आप मेल खाएँगे।', 'how.3t': '3. डाउनलोड करें।',
    'how.3d': 'PNG, JPG, WebP, SVG या प्रिंट-रेडी PDF में सहेजें, या सीधे अपने डिज़ाइन में कॉपी करें।',
    'f1.title': 'अपने ब्रांड से मेल खाता QR कोड बनाएँ।', 'f1.text': 'रंग, डॉट और कोने की शैली चुनें, फ़्रेम और लोगो जोड़ें। डाउनलोड से पहले हर कोड आपके ब्राउज़र में स्कैन-टेस्ट होता है।', 'f1.cta': 'QR कोड बनाएँ',
    'f2.title': 'ऐसा QR कोड जो अलग दिखे।', 'f2.text': 'फ़्लायर, मेन्यू, बिज़नेस कार्ड और पोस्टर पर इस्तेमाल करें। प्रिंट से पहले असली मॉकअप पर देखें।', 'f2.cta': 'QR कोड जनरेट करें',
    'why.title': 'QRForge क्यों', 'why.1t': 'डिज़ाइन से ही निजी', 'why.1d': 'स्टैटिक कोड आपके ब्राउज़र में बनते हैं। आप जो टाइप करते हैं वह हमारे सर्वर पर नहीं जाता।',
    'why.2t': 'स्टैटिक कोड कभी एक्सपायर नहीं होते', 'why.2d': 'स्टैटिक कोड में आपका डेटा सीधे होता है, इसलिए जब तक कंटेंट है, कोड चलता रहेगा।',
    'why.3t': 'हर बार स्कैन-टेस्ट', 'why.3d': 'हम आपका तैयार कोड डिकोड करते हैं और ज़रूरत हो तो डिज़ाइन अपने आप सरल कर देते हैं।',
    'why.4t': 'डायनामिक कोड और एनालिटिक्स', 'why.4d': 'छपे हुए कोड का गंतव्य बदलें, एक्सपायरी या पासवर्ड लगाएँ, और दिन, डिवाइस व देश के अनुसार स्कैन देखें।',
    'why.5t': 'बल्क जनरेशन', 'why.5d': 'सूची या CSV फ़ाइल से सैकड़ों कोड एक साथ बनाएँ और ZIP में डाउनलोड करें।', 'why.6t': 'प्रिंट के लिए तैयार', 'why.6d': 'वेक्टर SVG और माप वाला PDF, साथ में डॉट साइज़ और स्कैन दूरी की जाँच।',
    'use.title': 'हर ज़रूरत के लिए QR कोड', 'faq.title': 'अक्सर पूछे जाने वाले प्रश्न',
    'cta.title': 'अपना QR कोड बनाने के लिए तैयार?', 'cta.text': 'एक मिनट से भी कम समय लगता है।', 'cta.btn': 'अभी शुरू करें',
    'foot.tag': 'आपके ब्रांड से मेल खाते मुफ़्त QR कोड।', 'foot.create': 'बनाएँ', 'foot.learn': 'सीखें', 'foot.company': 'कंपनी',
    'auth.title': 'डायनामिक कोड के लिए साइन इन करें', 'auth.sub': 'मुफ़्त खाता। डायनामिक कोड बाद में बदले जा सकते हैं और स्कैन एनालिटिक्स दिखाते हैं।',
    'auth.email': 'ईमेल', 'auth.pass': 'पासवर्ड (8+ अक्षर)', 'auth.cancel': 'रद्द करें', 'auth.signup': 'खाता बनाएँ', 'auth.login': 'लॉग इन',
    'msg.copied': 'कॉपी हो गया', 'msg.linkcopied': 'शेयर लिंक कॉपी हो गया', 'msg.nologo': 'लोगो शेयर लिंक में शामिल नहीं होते',
    'msg.add': 'पहले कुछ जानकारी भरें।', 'msg.scanok': '✓ स्कैन टेस्ट सफल', 'msg.scanbad': '⚠ शायद स्कैन न हो: लोगो छोटा करें या कंट्रास्ट बढ़ाएँ',
    'msg.saved': 'डाउनलोड हो गया', 'msg.empty': 'QR कोड बनाने के लिए कुछ जानकारी भरें।',
  },
};

let lang = 'en';
try { lang = localStorage.getItem('qrf.lang') || 'en'; } catch { /* default */ }
if (!DICT[lang]) lang = 'en';

export const getLang = () => lang;
export const t = (key, fallback) => (lang !== 'en' && DICT[lang]?.[key]) || fallback || key;

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (el.dataset.en === undefined) el.dataset.en = el.innerHTML;
    const v = lang === 'en' ? null : DICT[lang]?.[el.dataset.i18n];
    el.innerHTML = v ?? el.dataset.en;
  }
  document.documentElement.lang = lang;
}

export function setLang(next) {
  lang = DICT[next] ? next : 'en';
  try { localStorage.setItem('qrf.lang', lang); } catch { /* ignore */ }
  applyI18n();
  document.dispatchEvent(new CustomEvent('langchange'));
}
