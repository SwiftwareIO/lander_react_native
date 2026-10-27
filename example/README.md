# Acme Shop

The example app of `react-native-lander`. It routes Lander links to a product screen at `/product/:id`, shows what Lander resolved for each link, creates share links with `Lander.createLink`, tracks purchases with `Lander.trackEvent` and claims a handoff behind **Sign in**.

Bundle ID and package name are `com.acme.shop`, the custom scheme is `acmeshop` and the link domain is `acme.golander.link` (Lander's demo project). It runs against a local copy of the Lander monorepo with the seeded demo key (see `index.js`).

```bash
# In the Lander monorepo: start Supabase and the workers
pnpm db:start && pnpm dev

# Here
npm install
cd ios && pod install && cd ..
npm run ios       # or: npm run android
```

Open a link:

```bash
xcrun simctl openurl booted "acmeshop://product/123"
adb shell am start -a android.intent.action.VIEW -d "acmeshop://product/123" com.acme.shop
```

