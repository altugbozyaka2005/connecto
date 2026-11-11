// Options for match preferences, shared by the browser (window.PREFS_DATA) and the server (require).
// Countries are ISO 3166 codes and languages ISO 639-1 codes; names come from Intl.DisplayNames.
(function (root) {
  const data = {
    GENDERS: ['woman', 'man', 'nonbinary'],
    AGE_BANDS: { '18-25': [18, 25], '26-35': [26, 35], '36-45': [36, 45], '46+': [46, 150] },
    MODES: ['video', 'voice', 'chat'], // richest first: a call uses the richest mode both people allow
    COUNTRIES: (
      'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ '
      + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
      + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
      + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR '
      + 'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE '
      + 'RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT '
      + 'TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
    ).split(' '),
    POPULAR_COUNTRIES: ['TR', 'GB', 'US', 'FR', 'DE', 'ES', 'IT', 'NL'],
    LANGUAGES: [
      'en', 'tr', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'ru', 'zh', 'ja', 'ko', 'hi', 'ur', 'fa', 'he', 'el',
      'pl', 'uk', 'ro', 'sv', 'no', 'da', 'fi', 'cs', 'sk', 'hu', 'bg', 'sr', 'hr', 'bs', 'sl', 'sq', 'az', 'ka',
      'hy', 'kk', 'uz', 'ku', 'id', 'ms', 'vi', 'th', 'tl', 'bn', 'ta', 'pa', 'sw', 'am',
    ],
    POPULAR_LANGUAGES: ['en', 'tr', 'fr', 'es', 'de', 'ar'],
    MAX_LANGUAGES: 5,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = data;
  else root.PREFS_DATA = data;
})(this);
