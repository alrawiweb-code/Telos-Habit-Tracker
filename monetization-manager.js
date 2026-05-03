import { adapty, createPaywallView } from '@adapty/capacitor';
import { AdMob, BannerAdPosition, BannerAdSize, BannerAdPluginEvents } from '@capacitor-community/admob';

const MonetizationManager = {
    // Phase 1: Mock Premium State
    // Set to true to test unlocked features, false to test paywalls.
    // In Phase 4, this is tied to Adapty's `profile.accessLevels['premium']?.isActive`
    _isPremium: false,
    _isAdaptyReady: false,
    _isAdMobReady: false,
    _bannerAdId: 'ca-app-pub-7978183450040245/3489528331',
    _rewardedHabitAdId: 'ca-app-pub-7978183450040245/5761442223',
    _rewardedPdfAdId: 'ca-app-pub-7978183450040245/4035840744',
    _pendingRewardCallback: null,
    _rewardEarned: false,
    _pendingActionContext: null, // { actionType, onSuccess } stored for Watch Again retry
    _isBannerVisible: false, // Tracks if a banner is currently showing (prevents redundant calls)
    _isBannerLoading: false, // Tracks if a banner request is currently in flight
    _hasBannerLoadedOnce: false, // Tracks if we've successfully loaded an ad once
    _oneTimeCounterKey: 'telos_onetime_add_count', // localStorage key for one-time task cycle counter

    // --- Ad Pre-caching & Network Awareness ---
    _isHabitAdReady: false,
    _isPdfAdReady: false,
    _isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    _adLoadRetryCount: 0,
    _maxAdRetries: 3,
    _adLoadTimeoutMs: 5000,
    _preloadTimer: null,

    // --- One-Time Task Counter (persisted via localStorage) ---
    getOneTimeAddCount() {
        return parseInt(localStorage.getItem(this._oneTimeCounterKey) || '0', 10);
    },
    incrementOneTimeAddCount() {
        const count = this.getOneTimeAddCount() + 1;
        localStorage.setItem(this._oneTimeCounterKey, count);
        return count;
    },
    resetOneTimeAddCount() {
        localStorage.setItem(this._oneTimeCounterKey, '0');
    },
    shouldGateOneTime() {
        // Gate on the 4th addition (after 3 free ones)
        return this.getOneTimeAddCount() >= 3;
    },

    async init() {
        // Load cached state from local storage on startup (offline support)
        const storedState = localStorage.getItem('telos_premium_state');
        if (storedState !== null) {
            this._isPremium = storedState === 'true';
        }
        
        console.log(`[Monetization] Initialized. Cached premium state: ${this._isPremium}`);

        // --- Network Awareness ---
        window.addEventListener('online', () => {
            this._isOnline = true;
            console.log('[Monetization] Network restored — pre-loading ads...');
            this._adLoadRetryCount = 0;
            this.preloadRewardedAds();
        });
        window.addEventListener('offline', () => {
            this._isOnline = false;
            console.log('[Monetization] Device went offline.');
        });
        
        // Initialize AdMob
        try {
            await AdMob.initialize({
                requestTrackingAuthorization: true,
                testingDevices: [], // Add your test device IDs here if needed
                initializeForTesting: false,
            });
            this._isAdMobReady = true;
            console.log('[Monetization] AdMob initialized successfully!');
            
            this.setupBannerListeners();
            this.setupRewardedListeners();
            // Show banner if not premium AND they have checked their first habit (Post-Value Delay)
            if (!this.isPremiumUser() && localStorage.getItem('telos_first_habit_checked') === 'true') {
                this.showBanner();
            }
            // Pre-cache rewarded ads in the background
            this.preloadRewardedAds();
        } catch (error) {
            console.error('[Monetization] Failed to initialize AdMob:', error);
        }

        // Initialize Adapty SDK
        try {
            await adapty.activate({
                apiKey: 'public_live_n22UTGQU.BEV2UMHAZrGBns3mItjP',
                params: {
                    logLevel: 'verbose',
                    __ignoreActivationOnFastRefresh: true,
                }
            });
            this._isAdaptyReady = true;
            console.log('[Monetization] Adapty activated successfully!');
            
            // Fetch real user profile to check subscription status
            await this.refreshProfile();
            
            // Pre-fetch main paywalls to eliminate lag when they are needed later
            this.prewarmPaywalls();
            
        } catch (error) {
            console.error('[Monetization] Failed to activate Adapty SDK:', error);
        }
    },

    async prewarmPaywalls() {
        if (!this._isAdaptyReady) return;
        const placements = ['paywall'];
        console.log('[Monetization] Pre-warming paywalls...');
        for (const pid of placements) {
            try {
                // This fetches and caches the paywall logic/UI in the background
                await adapty.getPaywall({ placementId: pid });
            } catch (e) {
                console.warn(`[Monetization] Failed to pre-warm ${pid}:`, e);
            }
        }
    },

    async refreshProfile() {
        if (!this._isAdaptyReady) return;
        
        try {
            const profile = await adapty.getProfile();
            const isSubscribed = profile.accessLevels['premium']?.isActive ?? false;
            console.log(`[Monetization] Fetched profile. Premium active: ${isSubscribed}`);
            this.setPremiumState(isSubscribed);
        } catch (error) {
            console.error('[Monetization] Failed to fetch Adapty profile:', error);
        }
    },

    async restorePurchases() {
        if (!this._isAdaptyReady) {
            console.warn('[Monetization] Cannot restore, Adapty not ready.');
            return false;
        }
        
        try {
            console.log('[Monetization] Restoring purchases...');
            const profile = await adapty.restorePurchases();
            const isSubscribed = profile.accessLevels['premium']?.isActive ?? false;
            console.log(`[Monetization] Restore complete. Premium active: ${isSubscribed}`);
            this.setPremiumState(isSubscribed);
            return isSubscribed;
        } catch (error) {
            console.error('[Monetization] Failed to restore purchases:', error);
            return false;
        }
    },

    isPremiumUser() {
        return this._isPremium;
    },

    setPremiumState(isPremium) {
        const stateChanged = this._isPremium !== isPremium;
        this._isPremium = isPremium;
        localStorage.setItem('telos_premium_state', isPremium);
        console.log(`[Monetization] Premium state updated to: ${this._isPremium}`);
        
        // Handle Ads based on premium status
        if (isPremium) {
            this.hideBanner();
        } else if (stateChanged) {
            this.showBanner();
        }

        // Dispatch event to re-render specific UI parts or refresh the app
        document.dispatchEvent(new CustomEvent('premiumStateChanged', { detail: { isPremium } }));
    },

    // --- AdMob Methods ---

    setupBannerListeners() {
        // Only apply the layout-shifting CSS class when the banner ACTUALLY loads
        AdMob.addListener(BannerAdPluginEvents.Loaded, () => {
            console.log('[Monetization] Banner ad loaded successfully.');
            this._isBannerVisible = true;
            this._hasBannerLoadedOnce = true;
            document.body.classList.add('has-banner-ad-top');
            document.dispatchEvent(new CustomEvent('bannerAdLoaded'));
        });

        AdMob.addListener(BannerAdPluginEvents.FailedToLoad, (error) => {
            console.warn('[Monetization] Banner ad failed to load:', error);
            this._isBannerVisible = false;
            document.body.classList.remove('has-banner-ad-top');
        });

        // Also handle the case where the ad is closed by the system
        AdMob.addListener(BannerAdPluginEvents.Closed, () => {
            console.log('[Monetization] Banner ad closed.');
            this._isBannerVisible = false;
            document.body.classList.remove('has-banner-ad-top');
        });
    },

    async showBanner() {
        if (!this._isAdMobReady || this.isPremiumUser()) return;
        if (this._isBannerVisible || this._isBannerLoading) return; // Already showing or loading — don't re-request

        this._isBannerLoading = true;
        try {
            console.log('[Monetization] Requesting banner ad...');
            await AdMob.showBanner({
                adId: this._bannerAdId,
                adSize: BannerAdSize.BANNER,
                position: BannerAdPosition.TOP_CENTER,
                margin: 0,
                // isTesting: true, // Set to true for development
            });
            
            // If the ad has already loaded once, the 'Loaded' event might not fire again.
            // We force the state and layout shift immediately to prevent the "disappearing" bug.
            if (this._hasBannerLoadedOnce) {
                this._isBannerVisible = true;
                document.body.classList.add('has-banner-ad-top');
            }
        } catch (error) {
            console.error('[Monetization] Failed to show banner:', error);
            document.body.classList.remove('has-banner-ad-top');
        } finally {
            this._isBannerLoading = false;
        }
    },

    async hideBanner() {
        if (!this._isAdMobReady) return;
        if (!this._isBannerVisible) return; // Already hidden — skip

        try {
            console.log('[Monetization] Hiding banner ad...');
            await AdMob.hideBanner();
            this._isBannerVisible = false;
            document.body.classList.remove('has-banner-ad-top');
        } catch (error) {
            console.error('[Monetization] Failed to hide banner:', error);
        }
    },



    onFirstHabitChecked() {
        if (!localStorage.getItem('telos_first_habit_checked')) {
            localStorage.setItem('telos_first_habit_checked', 'true');
            if (!this.isPremiumUser()) {
                this.showBanner();
            }
        }
    },

    // --- Ad Pre-caching Engine ---
    async preloadRewardedAds() {
        if (!this._isAdMobReady || this.isPremiumUser() || !this._isOnline) return;

        console.log(`[Monetization] Pre-loading rewarded ads (attempt ${this._adLoadRetryCount + 1}/${this._maxAdRetries})...`);

        // Pre-load habit ad
        if (!this._isHabitAdReady) {
            try {
                await AdMob.prepareRewardVideoAd({ adId: this._rewardedHabitAdId });
                this._isHabitAdReady = true;
                console.log('[Monetization] ✓ Habit rewarded ad pre-cached.');
            } catch (e) {
                this._isHabitAdReady = false;
                console.warn('[Monetization] ✗ Habit ad pre-load failed:', e.message || e);
            }
        }

        // Pre-load PDF ad
        if (!this._isPdfAdReady) {
            try {
                await AdMob.prepareRewardVideoAd({ adId: this._rewardedPdfAdId });
                this._isPdfAdReady = true;
                console.log('[Monetization] ✓ PDF rewarded ad pre-cached.');
            } catch (e) {
                this._isPdfAdReady = false;
                console.warn('[Monetization] ✗ PDF ad pre-load failed:', e.message || e);
            }
        }

        // If either failed, retry with exponential backoff
        if ((!this._isHabitAdReady || !this._isPdfAdReady) && this._adLoadRetryCount < this._maxAdRetries) {
            this._adLoadRetryCount++;
            const delay = Math.pow(2, this._adLoadRetryCount) * 1000; // 2s, 4s, 8s
            console.log(`[Monetization] Retrying pre-load in ${delay / 1000}s...`);
            if (this._preloadTimer) clearTimeout(this._preloadTimer);
            this._preloadTimer = setTimeout(() => this.preloadRewardedAds(), delay);
        } else if (this._isHabitAdReady && this._isPdfAdReady) {
            this._adLoadRetryCount = 0; // Reset on full success
        }
    },

    isAdReady(actionType) {
        return actionType === 'add_habit' ? this._isHabitAdReady : this._isPdfAdReady;
    },

    // --- Rewarded Ad Methods ---
    setupRewardedListeners() {
        AdMob.addListener('onRewardedVideoAdReward', (rewardItem) => {
            console.log(`[Monetization] Rewarded ad reward received: ${JSON.stringify(rewardItem)}`);
            this._rewardEarned = true;
            if (this._pendingRewardCallback) {
                // Increment view count for the day
                const dateKey = new Date().toISOString().split('T')[0];
                const countKey = `telos_rewarded_views_${dateKey}`;
                let count = parseInt(localStorage.getItem(countKey) || '0', 10);
                localStorage.setItem(countKey, count + 1);

                this._pendingRewardCallback();
                this._pendingRewardCallback = null;
                this._pendingActionContext = null;
            }
        });
        AdMob.addListener('onRewardedVideoAdDismissed', () => {
            console.log(`[Monetization] Rewarded ad dismissed`);
            // Mark pre-cached ads as consumed
            this._isHabitAdReady = false;
            this._isPdfAdReady = false;

            if (this._pendingRewardCallback && !this._rewardEarned) {
                // User closed the ad early — show the forfeit confirmation dialog
                console.log(`[Monetization] Ad closed early, showing forfeit dialog.`);
                this.showRewardForfeitDialog();
                // Do NOT clear _pendingRewardCallback or _pendingActionContext yet —
                // the user may choose "Watch Again" from the dialog.
            } else {
                // Reward was earned before dismiss (normal flow) — clean up
                this._pendingRewardCallback = null;
                this._pendingActionContext = null;
            }
            this._rewardEarned = false;

            // Auto-preload next ads for instant playback
            this._adLoadRetryCount = 0;
            setTimeout(() => this.preloadRewardedAds(), 500);
        });
        AdMob.addListener('onRewardedVideoAdFailedToLoad', (info) => {
            console.warn(`[Monetization] Rewarded ad failed to load: ${JSON.stringify(info)}`);
            this._isHabitAdReady = false;
            this._isPdfAdReady = false;
            this._pendingRewardCallback = null;
            this._pendingActionContext = null;
            this._rewardEarned = false;
        });
    },

    showRewardForfeitDialog() {
        // Dispatch event so app.js can show the forfeit modal
        document.dispatchEvent(new CustomEvent('showRewardForfeitDialog'));
    },

    async launchAdaptyPaywall(placementId, onCloseCallback, onSuccessCallback) {
        if (!this._isAdaptyReady) {
            console.warn('[Monetization] Adapty not ready, cannot launch paywall.');
            return false;
        }

        try {
            console.log(`[Monetization] Fetching Adapty paywall for placement: ${placementId}`);
            const paywall = await adapty.getPaywall({ placementId });
            console.log(`[Monetization] Paywall fetched successfully: ${paywall.developerId}`);
            const view = await createPaywallView(paywall, {
                loadTimeoutMs: 10000, // Explicitly provide timeout to avoid undefined error
            });
            console.log(`[Monetization] Paywall view created successfully`);


            view.setEventHandlers({
                onCloseButtonPress: () => {
                    console.log('[Monetization] Paywall event: onCloseButtonPress');
                    view.dismiss();
                    if (onCloseCallback) onCloseCallback();
                },
                onPurchaseCompleted: (profile) => {
                    console.log('[Monetization] Paywall event: onPurchaseCompleted');
                    view.dismiss();
                    const isPremium = profile.accessLevels['premium']?.isActive ?? false;
                    this.setPremiumState(isPremium);
                    if (isPremium && onSuccessCallback) onSuccessCallback();
                },
                onPurchaseFailed: (error) => {
                    console.error('[Monetization] Paywall event: onPurchaseFailed', error);
                },
                onRestoreCompleted: (profile) => {
                    console.log('[Monetization] Paywall event: onRestoreCompleted');
                    const isPremium = profile.accessLevels['premium']?.isActive ?? false;
                    this.setPremiumState(isPremium);
                    if (isPremium) {
                        view.dismiss();
                        if (onSuccessCallback) onSuccessCallback();
                    }
                }
            });

            console.log('[Monetization] Attempting to present paywall view...');
            await view.present();
            console.log('[Monetization] view.present() completed');
            return true;

        } catch (error) {
            console.error(`[Monetization] Failed to present Adapty paywall for ${placementId}:`, error);
            if (placementId !== 'paywall') {
               try {
                   console.log(`[Monetization] Retrying with default placement 'paywall'...`);
                   const fallbackPaywall = await adapty.getPaywall({ placementId: 'paywall' });
                   const fallbackView = await createPaywallView(fallbackPaywall, { loadTimeoutMs: 10000 });
                   fallbackView.setEventHandlers({
                       onCloseButtonPress: () => { fallbackView.dismiss(); if (onCloseCallback) onCloseCallback(); },
                       onPurchaseCompleted: (profile) => { 
                           fallbackView.dismiss(); 
                           const isPremium = profile.accessLevels['premium']?.isActive ?? false;
                           this.setPremiumState(isPremium);
                           if (isPremium && onSuccessCallback) onSuccessCallback(); 
                       },
                       onPurchaseFailed: (error) => { console.error('[Monetization] Purchase failed:', error); },
                       onRestoreCompleted: (profile) => { 
                           const isPremium = profile.accessLevels['premium']?.isActive ?? false;
                           this.setPremiumState(isPremium);
                           if (isPremium) { fallbackView.dismiss(); if (onSuccessCallback) onSuccessCallback(); }
                       }
                   });
                   await fallbackView.present();
                   return true;
               } catch (err2) {
                   console.error(`[Monetization] Fallback paywall also failed:`, err2);
               }
            }
            return false;
        }
    },

    async showRewardedOrPaywall(actionType, onSuccess) {
        if (this.isPremiumUser()) {
            onSuccess();
            return;
        }

        // Store context so "Watch Again" in the forfeit dialog can replay the ad
        this._pendingActionContext = { actionType, onSuccess };

        const runRewardedLogic = async () => {
            const adId = actionType === 'add_habit' ? this._rewardedHabitAdId : this._rewardedPdfAdId;

            try {
                console.log(`[Monetization] Preparing rewarded ad for ${actionType}...`);
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: true } }));
                await AdMob.prepareRewardVideoAd({ adId: adId });

                this._pendingRewardCallback = onSuccess;
                this._rewardEarned = false;

                console.log(`[Monetization] Showing rewarded ad...`);
                await AdMob.showRewardVideoAd();
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: false } }));
            } catch (error) {
                console.error('[Monetization] Failed to show rewarded ad:', error);
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: false } }));
                this._pendingRewardCallback = null;
                this._pendingActionContext = null;
                // Fallback to HTML paywall if ad fails to load
                const triggerId = 'paywall';
                this.showUpsellModalFallback(triggerId);
            }
        };

        // Expose runRewardedLogic so "Watch Again" can re-trigger just the ad (not the paywall)
        this._runRewardedLogic = runRewardedLogic;

        const placementId = 'paywall';

        // Show Adapty paywall first; if user closes it -> auto-play rewarded ad
        const success = await this.launchAdaptyPaywall(placementId, runRewardedLogic, onSuccess);

        // If Adapty paywall failed to launch (e.g. offline, no UI installed), go directly to rewarded ad
        if (!success) {
            runRewardedLogic();
        }
    },

    // Re-plays the rewarded ad without showing the paywall again (for "Watch Again" in forfeit dialog)
    async replayRewardedAd() {
        if (this._runRewardedLogic) {
            console.log('[Monetization] Replaying rewarded ad (Watch Again)...');
            await this._runRewardedLogic();
        } else {
            console.warn('[Monetization] No pending rewarded logic to replay.');
        }
    },

    // Plays a rewarded ad directly (no paywall cascade) — used by the premium upsell modal's "Watch Ad" button
    async showRewardedAd(actionType, onSuccess) {
        if (this.isPremiumUser()) {
            onSuccess();
            return;
        }

        this._pendingActionContext = { actionType, onSuccess };

        const runAd = async () => {
            const adId = actionType === 'add_habit' ? this._rewardedHabitAdId : this._rewardedPdfAdId;

            try {
                console.log(`[Monetization] Preparing rewarded ad (direct) for ${actionType}...`);
                
                // Show loading state in UI if possible
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: true } }));
                
                await AdMob.prepareRewardVideoAd({ adId });

                this._pendingRewardCallback = onSuccess;
                this._rewardEarned = false;

                console.log(`[Monetization] Showing rewarded ad...`);
                await AdMob.showRewardVideoAd();
                
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: false } }));
            } catch (error) {
                console.error('[Monetization] Rewarded ad failed, granting access as fallback:', error);
                document.dispatchEvent(new CustomEvent('showAdLoading', { detail: { loading: false } }));
                this._pendingRewardCallback = null;
                this._pendingActionContext = null;
                onSuccess(); // Don't block the user if ads fail
            }
        };


        this._runRewardedLogic = runAd;
        await runAd();
    },



    // --- Entitlement Checks ---

    canAddHabit(currentCount) {
        if (this.isPremiumUser()) return true;
        return currentCount < 10;
    },

    canCreateNewJournal(currentCount) {
        // Free users get max 3 journals. Premium get unlimited.
        if (this.isPremiumUser()) return true;
        return currentCount < 3;
    },

    canMoveToSecrets(secretsCount) {
        // Monetize security: Free users get 1 secret
        if (this.isPremiumUser()) return true;
        return secretsCount < 1;
    },

    canExportPDF() {
        // Free users cannot export PDF
        return this.isPremiumUser();
    },

    // --- Upsell Triggers ---

    showUpsellModal(triggerId) {
        console.log(`[Monetization] Paywall triggered: ${triggerId}`);
        
        // INSTANT FEEDBACK: Show our beautiful HTML modal immediately.
        // This eliminates the network lag associated with fetching Adapty paywalls.
        this.showUpsellModalFallback(triggerId);
    },

    showUpsellModalFallback(triggerId) {
        console.log(`[Monetization] HTML Paywall Fallback: ${triggerId}`);
        document.dispatchEvent(new CustomEvent('showPremiumUpsell', { detail: { triggerId } }));
    },


};

// Make it globally available so app.js can access it
window.MonetizationManager = MonetizationManager;

// Initialize early
MonetizationManager.init();

