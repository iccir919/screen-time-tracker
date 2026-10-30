// default_apps.mjs
//
// Built-in names and categories for common apps. Anything not listed here
// shows as the last part of its app ID, in "Other", until you name it on
// the Apps page. Your own names, categories and category colors are saved
// in your archive database, never in this file, and they take priority
// over these defaults.

// The colors you can pick for a category, in order. The shades are
// --cat-1 to --cat-10 in public/base.css: soft colors, chosen so any two are
// easy to tell apart. Categories can share a color.
export const COLOR_NAMES = ["Blue", "Orange", "Aqua", "Yellow", "Pink", "Green", "Violet", "Red", "Sky", "Brown"];

// "Other" is always there, always gray, and can't be renamed or deleted
export const OTHER_ID = "other";
export const OTHER_NAME = "Other";

// The categories you start with. You can rename, recolor, reorder or
// delete them on the Apps page. The IDs never change, so renaming a
// category keeps its apps.
export const DEFAULT_CATEGORIES = [
  { id: "video_music", name: "Video & Music", color: 0 },
  { id: "social", name: "Social", color: 1 },
  { id: "messaging", name: "Messaging", color: 2 },
  { id: "web", name: "Web", color: 3 },
  { id: "productivity", name: "Productivity", color: 4 },
  { id: "navigation", name: "Navigation", color: 5 },
  { id: "games", name: "Games", color: 6 },
  { id: "health_learning", name: "Health & Learning", color: 7 },
];

// App ID -> [name, category ID]
export const DEFAULT_APPS = {
  // Video & Music
  "com.google.ios.youtube": ["YouTube", "video_music"],
  "com.google.ios.youtubemusic": ["YouTube Music", "video_music"],
  "com.netflix.Netflix": ["Netflix", "video_music"],
  "com.spotify.client": ["Spotify", "video_music"],
  "com.apple.Music": ["Music", "video_music"],
  "com.apple.TV": ["TV", "video_music"],
  "com.apple.podcasts": ["Podcasts", "video_music"],

  // Social
  "com.burbn.instagram": ["Instagram", "social"],
  "com.atebits.Tweetie2": ["X", "social"],
  "com.reddit.Reddit": ["Reddit", "social"],
  "com.linkedin.LinkedIn": ["LinkedIn", "social"],
  "com.facebook.Facebook": ["Facebook", "social"],
  "com.zhiliaoapp.musically": ["TikTok", "social"],
  "com.toyopagroup.picaboo": ["Snapchat", "social"],

  // Messaging
  "com.apple.MobileSMS": ["Messages", "messaging"],
  "com.facebook.Messenger": ["Messenger", "messaging"],
  "net.whatsapp.WhatsApp": ["WhatsApp", "messaging"],
  "com.apple.InCallService": ["Phone calls", "messaging"],
  "com.apple.mobilephone": ["Phone", "messaging"],
  "com.apple.facetime": ["FaceTime", "messaging"],
  "com.apple.FaceTime": ["FaceTime", "messaging"],
  "com.google.Gmail": ["Gmail", "messaging"],
  "com.apple.mobilemail": ["Mail", "messaging"],
  "com.apple.mail": ["Mail", "messaging"],
  "com.tinyspeck.slackmacgap": ["Slack", "messaging"],
  "com.tinyspeck.chatlyio": ["Slack", "messaging"],
  "us.zoom.xos": ["Zoom", "messaging"],
  "us.zoom.videomeetings": ["Zoom", "messaging"],

  // Web
  "com.google.Chrome": ["Chrome", "web"],
  "com.google.chrome.ios": ["Chrome", "web"],
  "com.apple.Safari": ["Safari", "web"],
  "com.apple.mobilesafari": ["Safari", "web"],
  "org.mozilla.firefox": ["Firefox", "web"],
  "org.mozilla.ios.Firefox": ["Firefox", "web"],
  "com.duckduckgo.mobile.ios": ["DuckDuckGo", "web"],

  // Productivity
  "com.microsoft.VSCode": ["VS Code", "productivity"],
  "com.apple.Terminal": ["Terminal", "productivity"],
  "notion.id": ["Notion", "productivity"],
  "com.github.GitHubClient": ["GitHub Desktop", "productivity"],
  "com.github.stormbreaker.prod": ["GitHub", "productivity"],
  "com.anthropic.claude": ["Claude", "productivity"],
  "com.anthropic.claudefordesktop": ["Claude", "productivity"],
  "com.openai.chat": ["ChatGPT", "productivity"],
  "com.google.calendar": ["Google Calendar", "productivity"],
  "com.apple.iCal": ["Calendar", "productivity"],
  "com.apple.mobilecal": ["Calendar", "productivity"],
  "com.apple.Notes": ["Notes", "productivity"],
  "com.apple.mobilenotes": ["Notes", "productivity"],
  "com.apple.reminders": ["Reminders", "productivity"],
  "com.apple.finder": ["Finder", "productivity"],
  "com.apple.systempreferences": ["System Settings", "productivity"],
  "com.apple.Preferences": ["Settings", "productivity"],
  "com.google.Translate": ["Google Translate", "productivity"],

  // Navigation
  "com.apple.Maps": ["Apple Maps", "navigation"],
  "com.apple.maps": ["Apple Maps", "navigation"],
  "com.google.Maps": ["Google Maps", "navigation"],
  "com.apple.findmy": ["Find My", "navigation"],
  "com.ubercab.UberClient": ["Uber", "navigation"],

  // Health & Learning
  "com.fitbit.FitbitMobile": ["Fitbit", "health_learning"],
  "com.strava.stravaride": ["Strava", "health_learning"],
  "com.apple.Health": ["Health", "health_learning"],
  "com.duolingo.DuolingoMobile": ["Duolingo", "health_learning"],

  // Other
  "com.apple.mobileslideshow": ["Photos", OTHER_ID],
  "com.apple.Photos": ["Photos", OTHER_ID],
  "com.apple.camera": ["Camera", OTHER_ID],
  "com.apple.mobiletimer": ["Clock", OTHER_ID],
  "com.apple.Passbook": ["Wallet", OTHER_ID],
  "com.apple.PassbookUIService": ["Wallet", OTHER_ID],
  "com.apple.weather": ["Weather", OTHER_ID],
  "com.apple.AppStore": ["App Store", OTHER_ID],
  "com.apple.control-center": ["Control Center", OTHER_ID],
  "com.amazon.Amazon": ["Amazon", OTHER_ID],
  "com.apple.Installer-Progress": ["macOS Installer", OTHER_ID],
};
