// Longer, genuinely useful guide text shown under the tool on each landing page.
// This is what lets a page rank for specific searches such as "UPI QR code generator free".
export const GUIDES = {
  'upi-qr-code-generator': {
    intro: 'A UPI QR code lets customers pay you from any UPI app (Google Pay, PhonePe, Paytm, BHIM and bank apps) by scanning once, with no typing of your ID. This free generator creates the code in your browser, with no sign-up and no watermark.',
    steps: [
      'Enter your UPI ID, for example yourname@bank, and the name shown to the payer.',
      'Optionally add a fixed amount and a note such as an invoice number. Leave the amount empty for a counter code.',
      'Add your logo or brand colours, then download as PNG, or SVG/PDF for print.',
      'Scan it with at least two UPI apps and make a small test payment before you print.',
    ],
    sections: [
      ['Fixed amount or open amount?', 'Add an amount when the price is known, such as an invoice, a class fee or a booking. Leave it blank for a shop counter, where each customer types what they owe. Some apps let the payer edit a fixed amount, so always check the amount you receive.'],
      ['Where to put your payment QR', 'Shop counters, tables, delivery bags, invoices, WhatsApp catalogues and social media posts. Print at least 3 cm wide on a flat, matte surface, because glare makes scanning slow.'],
      ['Is this safe?', 'The code only contains the payment link, and QRForge never processes or sees any payment. Money moves directly through UPI. Double-check your UPI ID, and watch for stickers placed over yours, because scammers swap payment codes.'],
    ],
  },
  'whatsapp-qr-code-generator': {
    intro: 'A WhatsApp QR code opens a chat with your number, with a message already typed if you want. It suits shops, clinics, coaching classes and freelancers who take orders and enquiries on WhatsApp.',
    steps: [
      'Enter your number with the country code, for example 91 followed by your 10 digits.',
      'Optionally type a pre-filled message such as "Hi, I would like to order".',
      'Style the code with your logo and colours, then download it.',
      'Scan it with your own phone to confirm the chat opens with the right number.',
    ],
    sections: [
      ['Why add a pre-filled message?', 'It tells you where the customer came from and saves them typing. Use a different message per poster or product, for example "Hi, I saw your Diwali offer", to learn which placement works.'],
      ['Works with WhatsApp Business', 'The same link works for personal and Business numbers. For a team inbox, use the number linked to your Business account.'],
    ],
  },
  'wifi-qr-code-generator': {
    intro: 'A Wi-Fi QR code lets guests join your network by scanning, with no password typing. Create one free for your home, cafe, office or hotel room.',
    steps: [
      'Enter your network name (SSID) exactly as it appears, including capitals.',
      'Choose the security type, usually WPA/WPA2, and enter the password.',
      'Download and print the code, or use a frame and table tent mockup.',
      'Test with an iPhone and an Android phone.',
    ],
    sections: [
      ['Keep a separate guest network', 'The password is stored in the code, so anyone who scans it can read it. Put it on a guest network so visitors never touch your main devices.'],
      ['If the phone does not join', 'Check the name and password for typos, and that the security type matches your router. Very old Android versions may need a scanner app.'],
    ],
  },
  'menu-qr-code-generator': {
    intro: 'A menu QR code lets diners open your menu on their phone. Link to a web page or PDF, and make the code dynamic so you can change the menu without reprinting table cards.',
    steps: [
      'Upload your menu as a web page or PDF and copy its link.',
      'Paste the link in the URL field and tick dynamic if you will change it.',
      'Add your logo, preview it on a table tent, and download.',
      "Print at 4 to 5 cm and test from arm's length.",
    ],
    sections: [
      ['Static or dynamic for menus?', 'Menus change with seasons and prices, so dynamic is the safer choice. The printed code stays the same and you change where it points from the dashboard.'],
      ['Making the menu load fast', 'Diners scan in a hurry. Keep PDFs small, use a mobile-friendly page, and avoid sign-in walls.'],
    ],
  },
  'url-qr-code-generator': {
    intro: 'Turn any website address into a QR code. Use it for your site, a landing page, an app download page, an online form or a social profile.',
    steps: [
      'Paste the full web address, starting with https://.',
      'Choose colours or upload your logo to match your brand.',
      'Download PNG for screens, or SVG/PDF for print.',
      'Make it dynamic if you want to edit the link later or track scans.',
    ],
    sections: [
      ['Static vs dynamic URL codes', 'Static codes hold the address itself, are free forever, and cannot be edited. Dynamic codes point to a short link you control, so you can change the destination, set an expiry, add a password and see scans.'],
      ['Print size and contrast', 'Use dark dots on a light background, keep a clear border of at least four dots, and print at 2 cm or more.'],
    ],
  },
  'vcard-qr-code-generator': {
    intro: 'A vCard QR code saves your name, phone, email, company and website to a phone in one scan. It is the digital version of handing over a business card.',
    steps: [
      'Fill in your name and the details you want to share.',
      'Keep fields short. More data makes a denser, harder-to-scan code.',
      'Preview it on a business card mockup and download SVG or PDF.',
      'Scan it to confirm the phone offers to add the contact.',
    ],
    sections: [
      ['vCard or landing page?', 'A vCard works offline and stores everything in the code. A dynamic landing page lets you update details later and show several links, so it suits people who change numbers or roles.'],
    ],
  },
  'business-card-qr-code': {
    intro: 'Add a QR code to your business card so people can save your details or open your portfolio, without typing anything.',
    steps: [
      'Choose a contact (vCard) code or a link to your website or portfolio.',
      'Add your logo so the code matches your brand.',
      'Preview it on the card mockup, then download.',
      'Send the SVG or PDF to your printer and ask for a proof.',
    ],
    sections: [
      ['Where to place it', 'The back of the card is cleanest. Leave a quiet border, keep it at least 2 cm wide, and avoid glossy lamination over the code, which can reflect light.'],
    ],
  },
  'google-review-qr-code-generator': {
    intro: 'A Google review QR code opens your business review form in one scan. Put it on bills, counters and packaging so happy customers can leave a review in seconds. More reviews help local customers find you.',
    steps: [
      'In your Google Business Profile, choose "Ask for reviews" and copy your review link.',
      'Paste the link in the URL field above.',
      'Add your logo, then download PNG or print-ready PDF.',
      'Place it at the point of sale, with a short line such as "Enjoyed your visit? Scan to review".',
    ],
    sections: [
      ['Track which spot works best', 'Make a separate dynamic code for each counter, table or branch. The dashboard shows scans per code, so you can see where reviews come from.'],
    ],
  },
  'pdf-qr-code-generator': {
    intro: 'A PDF QR code opens a brochure, catalogue, menu or manual on the phone. Host the file online, paste its link, and download your code.',
    steps: [
      'Upload the PDF to Google Drive, Dropbox or your website and set it to "anyone with the link can view".',
      'Copy the link and paste it in the URL field above.',
      'Make it dynamic if you will replace the file later.',
      'Download and test the code on a phone before printing.',
    ],
    sections: [
      ['Keep the file light', 'Phone users are often on mobile data. Compress the PDF so it opens within a couple of seconds.'],
    ],
  },
};
