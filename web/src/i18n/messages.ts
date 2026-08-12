// Shape shared by every locale file — add new keys here first (mirrors the
// bot's own convention: src/i18n/locales/en.ts is the source of types there).
export interface Messages {
    common: {
        loading: string;
        error: string;
        retry: string;
        empty: string;
        prev: string;
        next: string;
        logout: string;
        search: string;
        all: string;
        yes: string;
        no: string;
        back: string;
        /** Pagination footer, e.g. "26-50 of 214". */
        range: (from: number, to: number, total: number) => string;
        close: string;
        /** Accessible name of a dialog's close button, naming the dialog it closes. */
        closeNamed: (title: string) => string;
    };
    nav: {
        /** Accessible name of the drawer button, both states. */
        menu: string;
        close: string;
        breadcrumbs: string;
        servers: string;
        overview: string;
        seeAll: string;
        language: string;
        skipToContent: string;
        sections: {
            campaign: string;
            adventure: string;
            company: string;
            world: string;
            treasures: string;
        };
    };
    theme: {
        label: string;
        system: string;
        light: string;
        dark: string;
    };
    /**
     * The thin bar at the bottom of the app.
     *
     * Same promise the bot makes in `$dona`, in one line: nothing is sold, and
     * a donation buys nothing either.
     */
    support: {
        /** Accessible name of the bar itself. */
        label: string;
        tagline: string;
        donate: string;
        /** Title of the donation item while the channel is not open yet. */
        donateInactive: string;
        source: string;
        license: string;
    };
    /** The register of paid AI work: the corner card and the bell. */
    aiJobs: {
        dockLabel: string;
        bellLabel: string;
        bellWithCount: (count: number) => string;
        empty: string;
        working: string;
        readyToReview: string;
        done: string;
        failed: string;
        /** A restart killed it mid-flight; it may already have been charged. */
        interrupted: string;
        discarded: string;
        expired: string;
        kind: {
            image: string;
            appearance: string;
            'quest-audit': string;
            'character-bio': string;
        };
    };
    errors: {
        /** A 403 is a valid session on someone else's campaign — not a failure to retry. */
        forbidden: string;
        forbiddenHint: string;
        notFound: string;
        /**
         * The AI provider was busy or unreachable. Nothing here is broken and
         * there is nothing to configure: the answer is to click again.
         */
        providerBusy: string;
    };
    login: {
        title: string;
        subtitle: string;
        cta: string;
    };
    guilds: {
        title: string;
        subtitle: string;
        empty: string;
        manage: string;
    };
    campaigns: {
        title: string;
        active: string;
        empty: string;
    };
    overview: {
        year: string;
        location: string;
        party: string;
        lastSession: string;
        noSession: string;
        counts: {
            sessions: string;
            openQuests: string;
            npcs: string;
            locations: string;
            factions: string;
            inventory: string;
            artifacts: string;
            bestiary: string;
        };
    };
    sessions: {
        eyebrow: string;
        archiveTitle: string;
        archiveSubtitle: string;
        archivePagination: string;
        empty: string;
        untitled: string;
        openSession: string;
        sessionNumber: (number: number) => string;
        readerNavigation: string;
        previousSession: string;
        nextSession: string;
        index: string;
        brief: string;
        chronicle: string;
        participants: string;
        references: string;
        notes: string;
        media: string;
        audio: string;
        audioUnavailable: string;
        transcript: string;
        transcriptSubtitle: string;
        showTranscript: string;
        backToSession: string;
        transcriptEmpty: string;
        unknownSpeaker: string;
        beginningOfChronicle: string;
        endOfChronicle: string;
        /** Act count on the session badge row. */
        acts: (count: number) => string;
        /** Token count on the session badge row; the figure arrives already formatted for the locale. */
        tokens: (formatted: string) => string;
    };
    statuses: {
        OPEN: string;
        IN_PROGRESS: string;
        COMPLETED: string;
        FAILED: string;
        ACTIVE: string;
        DISBANDED: string;
        DESTROYED: string;
        ALIVE: string;
        DEAD: string;
        UNKNOWN: string;
        MISSING: string;
        FUNCTIONAL: string;
        LOST: string;
        SEALED: string;
        DORMANT: string;
        DEFEATED: string;
        FLED: string;
        ESCAPED: string;
    };
    quests: {
        newQuest: string;
        editQuest: string;
        deleteQuest: string;
        confirmDelete: (title: string) => string;
        cancel: string;
        save: string;
        saving: string;
        deleting: string;
        created: string;
        aiKicker: string;
        aiSuggestions: string;
        evidence: string;
        apply: string;
        dismiss: string;
        auditHistory: string;
        auditing: string;
        auditDone: (count: number) => string;
        /** The audit now runs on its own; the corner card reports the outcome. */
        auditStarted: string;
        types: {
            MAJOR: string;
            MINOR: string;
        };
    };
    aiCost: {
        indicatorLabel: string;
        indicatorDescription: string;
        kicker: string;
        modalTitle: string;
        intro: string;
        /** Under BYOK the spend happens on the user's provider account, not on ours. */
        byokNotice: string;
        costWithoutResults: string;
        action: string;
        questHistoryAudit: string;
        scope: string;
        scopeValue: (sessions: number, quests: number) => string;
        providerModel: string;
        inputTokens: string;
        outputTokens: string;
        estimatedCost: string;
        pricingUnavailable: string;
        localProviderCost: string;
        exchangeEcb: string;
        exchangeStale: string;
        exchangeUnavailable: string;
        disclaimer: string;
        confirm: string;
        runningAction: string;
        loadingEstimate: string;
        auditAlreadyRunning: string;
        auditCooldown: string;
        auditNoSessions: string;
        auditNothingToAudit: string;
        actualCost: (tokens: number, cost: string) => string;
        /**
         * Saving a card does not call the AI right away, it marks it for
         * regeneration: at the next session's sync the Bardo rewrites its
         * description with the configured model.
         */
        deferredRegenLabel: string;
        deferredRegenDescription: string;
    };
    timeline: {
        subtitle: string;
        unknownYear: string;
        types: {
            WAR: string;
            POLITICS: string;
            DISCOVERY: string;
            CALAMITY: string;
            DISASTER: string;
            SUPERNATURAL: string;
            RELIGION: string;
            MYTH: string;
            DEATH: string;
            BIRTH: string;
            CONSTRUCTION: string;
            GENERIC: string;
        };
    };
    inventory: {
        artifact: string;
        cursed: string;
        category: string;
        allCategories: string;
        saveCategory: string;
        categorySaved: string;
        categories: {
            WEAPON: string;
            ARMOR: string;
            CONSUMABLE: string;
            TOOL: string;
            MATERIAL: string;
            TREASURE: string;
            QUEST_ITEM: string;
            OTHER: string;
        };
    };
    media: {
        image: string;
        upload: string;
        replace: string;
        remove: string;
        confirmRemove: string;
        cancel: string;
        altText: string;
        focalX: string;
        focalY: string;
        saveDetails: string;
        uploadHint: string;
        /** Shown next to every file picker: uploads are not screened, so the rights are the uploader's to hold. */
        rightsHint: string;
        invalidFile: string;
        tooLarge: string;
        updated: string;
        /** Accessible name of the button that opens a picture full screen. */
        enlarge: string;
        previousImage: string;
        nextImage: string;
        imageOfMany: (position: number, total: number) => string;

        /*
         * Generating a picture with the AI.
         *
         * It is the most expensive single action in the product, so the wording
         * carries the cost rather than hiding it, and `costUnknown` exists
         * because an unknown rate must never be shown as free.
         */
        generateTitle: string;
        generateHint: string;
        modeAuto: string;
        modeAutoHint: string;
        modePrompt: string;
        modePromptHint: string;
        modeMixed: string;
        modeMixedHint: string;
        promptLabel: string;
        promptPlaceholder: string;
        generate: string;
        regenerate: string;
        generating: string;
        preview: string;
        previewHint: string;
        keep: string;
        keeping: string;
        discard: string;
        generatedWith: (provider: string, model: string) => string;
        generatedFrom: string;
        actualCost: (cost: string) => string;
        costUnknown: string;
        noImageModel: string;
        /** Which record the picture was drawn from — the analysed one, or the weaker fallback. */
        drawnFromDossier: string;
        drawnWithoutDossier: string;
        referencesUsed: (count: number) => string;

        /** The gallery: an entity holds several pictures, one of which the sheet shows. */
        gallery: string;
        galleryHint: string;
        makePrimary: string;
        primary: string;
        removeOne: string;
        confirmRemoveOne: string;

        /*
         * How the picture should be taken.
         *
         * Closed sets: each option maps to one phrase the model understands, so
         * they can be translated freely without changing what is asked for.
         */
        shot: string;
        shotHint: string;
        framing: string;
        pose: string;
        light: string;
        background: string;
        shotDefault: string;
        shotOptions: Record<string, string>;

        /** Which pictures to draw from. Nothing is sent unless it is ticked. */
        referencePicker: string;
        referencePickerHint: string;
        referenceScopes: Record<string, string>;
        noReferences: string;
        oneTimeReference: string;
        oneTimeReferenceHint: string;
        /** Shown while the picture is being drawn: leaving the page is safe. */
        drawingInBackground: string;
        /** A job a restart killed. It may already have been charged. */
        jobInterrupted: string;
    };

    /*
     * The appearance dossier: what the campaign records about how a subject
     * looks, with the evidence for each claim.
     *
     * The wording is deliberately plain about absence. A portrait drawn from an
     * invented description is wrong in a way that is hard to notice, so the
     * interface has to make "the records do not say" as visible as any other
     * answer.
     */
    profile: {
        title: string;
        hint: string;
        appearance: string;
        personality: string;
        empty: string;
        analyze: string;
        reanalyze: string;
        analyzing: string;
        analyzed: string;
        notRecorded: string;
        keptManual: string;
        manualBadge: string;
        staleBadge: string;
        staleHint: string;
        confidence: string;
        confidences: { HIGH: string; MEDIUM: string; LOW: string };
        showEvidence: string;
        hideEvidence: string;
        evidenceTitle: string;
        sources: {
            sheet: string;
            history: string;
            faction: string;
            transcript: string;
            rag: string;
        };
        fromSession: (session: string) => string;
        analyzedWith: (provider: string, model: string) => string;
        edit: string;
        appearanceLabel: string;
        personalityLabel: string;
        appearancePlaceholder: string;
        personalityPlaceholder: string;
        save: string;
        saving: string;
        saved: string;
        cancel: string;
        /** Names of the dossier fields; a missing one falls back to the raw path. */
        fieldNames: Record<string, string>;
        writeHint: string;
        byAi: string;
        byHand: string;
        listHint: string;
        keptFields: (count: number) => string;
    };

    /** Reference pictures the image model is told to draw from. */
    references: {
        title: string;
        campaignHint: string;
        factionHint: string;
        add: string;
        adding: string;
        label: string;
        labelPlaceholder: string;
        remove: string;
        confirmRemove: string;
        empty: string;
        artDirection: string;
        artDirectionHint: string;
        artDirectionPlaceholder: string;
    };
    /** Column headers and detail-view labels. Until now these were English literals in every locale. */
    fields: {
        id: string;
        name: string;
        title: string;
        type: string;
        race: string;
        class: string;
        status: string;
        role: string;
        region: string;
        place: string;
        item: string;
        quantity: string;
        count: string;
        number: string;
        date: string;
        alignment: string;
        reputation: string;
        description: string;
        effects: string;
        curse: string;
        owner: string;
        abilities: string;
        weaknesses: string;
        resistances: string;
        notes: string;
        variants: string;
        acquired: string;
        lastSeen: string;
        session: string;
        updated: string;
        history: string;
        aliases: string;
        year: string;
    };
    /** Entity editor, deletion and the shared validation messages. */
    crud: {
        /** E.g. "New NPC" — the family name comes from `entities`. */
        createTitle: (entity: string) => string;
        editTitle: (entity: string) => string;
        create: string;
        edit: string;
        delete: string;
        save: string;
        saving: string;
        cancel: string;
        deleting: string;
        confirmDelete: (name: string) => string;
        /** What the cascade takes away, stated before asking for confirmation. */
        deleteCascade: string;
        irreversible: string;
        deleted: (name: string) => string;
        deleteReport: (history: number, fragments: number) => string;
        listHint: string;
        fieldRequired: (field: string) => string;
        fieldTooLong: (field: string, max: number) => string;
        fieldNotInteger: (field: string) => string;
        fieldOutOfRange: (field: string, min: number, max: number) => string;
    };
    /** Editing the history: description, type and weight on the alignment. */
    events: {
        edit: string;
        delete: string;
        confirmDelete: string;
        eventType: string;
        moralWeight: string;
        ethicalWeight: string;
        /** Spiega la scala −10..+10 e cosa succede salvando. */
        weightHint: string;
        /** Heading of the delta shown on the event row. */
        alignmentImpact: string;
        noImpact: string;
        /** Compact axis labels on an event's badge. */
        moralShort: string;
        ethicalShort: string;
        recalculated: string;
    };
    /** Long-term memory (RAG) linked to an entity. */
    fragments: {
        title: string;
        subtitle: string;
        empty: string;
        count: (total: number) => string;
        show: string;
        hide: string;
        expand: string;
        collapse: string;
        /** The card regenerated by the pipeline, distinct from session memories. */
        snapshot: string;
        sessionMemory: string;
        delete: string;
        confirmDelete: string;
        /** A deleted session memory does not come back: the transcript is not reprocessed. */
        deleteWarning: string;
        /** The official card, on the other hand, is regenerated at the next sync. */
        deleteSnapshotWarning: string;
    };
    /**
     * The API ships alignment as enum keys ('CHAOTIC_GOOD'), never translated —
     * it stays locale-agnostic and the wording lives only here. These strings are
     * copied verbatim from the bot's own locales (src/i18n/locales/*.ts) so the
     * two surfaces name the same alignment the same way.
     */
    align: {
        moral: string;
        ethical: string;
        /** Single-axis words, used as the poles of each bar. */
        axis: {
            GOOD: string;
            EVIL: string;
            LAWFUL: string;
            CHAOTIC: string;
            NEUTRAL: string;
        };
        /** The nine cells, keyed `${ethical}_${moral}`. */
        pairs: {
            LAWFUL_GOOD: string;
            NEUTRAL_GOOD: string;
            CHAOTIC_GOOD: string;
            LAWFUL_NEUTRAL: string;
            NEUTRAL_NEUTRAL: string;
            CHAOTIC_NEUTRAL: string;
            LAWFUL_EVIL: string;
            NEUTRAL_EVIL: string;
            CHAOTIC_EVIL: string;
        };
    };
    party: {
        groupAlignment: string;
        members: string;
        /** Where the group alignment came from — the party faction, or the campaign fallback. */
        fromFaction: string;
        fromCampaign: string;
        noBio: string;
    };
    reputation: {
        label: string;
        levels: {
            HOSTILE: string;
            DISTRUSTFUL: string;
            COLD: string;
            NEUTRAL: string;
            CORDIAL: string;
            FRIENDLY: string;
            ALLIED: string;
        };
    };
    entities: {
        characters: string;
        npcs: string;
        locations: string;
        factions: string;
        quests: string;
        inventory: string;
        artifacts: string;
        bestiary: string;
        timeline: string;
        sessions: string;
    };
    report: {
        /** Accessible name of the red header button. */
        buttonLabel: string;
        title: string;
        subtitle: string;
        type: string;
        types: {
            BUG: string;
            UI: string;
            UX: string;
            DATA: string;
            FLOW: string;
            PERFORMANCE: string;
            SECURITY: string;
            CONTENT: string;
            FEATURE: string;
            OTHER: string;
        };
        severity: string;
        severities: {
            low: string;
            medium: string;
            high: string;
            critical: string;
        };
        /** "No severity" option label for the optional severity select. */
        severityNone: string;
        description: string;
        descriptionHint: string;
        steps: string;
        stepsHint: string;
        screenshot: string;
        screenshotHint: string;
        screenshotChoose: string;
        /** Segmented control: choose how to provide the screenshot. */
        sourceUpload: string;
        sourceCapture: string;
        /** Capture mode. */
        captureStart: string;
        captureHint: string;
        /** Visible briefly while the browser shows its screen-source picker. */
        capturing: string;
        /** Shown (and toggle hidden) when getDisplayMedia is unavailable. */
        captureUnsupported: string;
        captureError: string;
        /** In-editor screenshot editor. */
        editorTitle: string;
        editorHint: string;
        toolCrop: string;
        toolPen: string;
        toolArrow: string;
        toolRect: string;
        toolHighlight: string;
        colorLabel: string;
        undo: string;
        clear: string;
        applyCrop: string;
        cropHint: string;
        annotateHint: string;
        confirm: string;
        retake: string;
        cancelEdit: string;
        /** Remove the attached screenshot (upload or capture) from the form. */
        removeScreenshot: string;
        send: string;
        sending: string;
        cancel: string;
        /** Success confirmation, e.g. "Report #000012 sent." */
        success: (number: string) => string;
        invalidFile: string;
        tooLarge: string;
        required: string;
        error: string;
    };
    merge: {
        /** Header button label (manage-gated). */
        button: string;
        title: string;
        /** Shown when no duplicate clusters were detected. */
        noDuplicates: string;
        /** Toggle to enable semantic (embedding-based) duplicate detection. */
        semanticToggle: string;
        /** Review step heading. */
        review: string;
        reviewHint: string;
        /** "Pick the survivor" legend. */
        survivorPick: string;
        survives: string;
        dies: string;
        historyEvents: (count: number) => string;
        ragPresent: string;
        ragAbsent: string;
        manualBadge: string;
        scoreLabel: string;
        /** Override the survivor description. */
        descriptionOverride: string;
        descriptionPlaceholder: string;
        /** Confirm step heading. */
        confirm: string;
        confirmSummary: string;
        /** Warning when a drop is manual (is_manual=1). */
        manualWarning: string;
        /** First-click merge button (morphs to confirm). */
        mergeBtn: string;
        /** Second-click confirm button. */
        confirmMerge: string;
        cancel: string;
        merging: string;
        /** Success step heading. */
        success: string;
        successSummary: (survivor: string) => string;
        reportMerged: (count: number) => string;
        reportHistory: (count: number) => string;
        reportRagDeleted: (count: number) => string;
        reportRagRefs: (count: number) => string;
        reportShortId: string;
        reportManual: string;
        reportBio: string;
        viewSurvivor: string;
        error: string;
        /** Loading text while detecting duplicates. */
        detecting: string;
        /** Checkbox label: merge this duplicate into the survivor. */
        mergeThis: string;
        /** Merge button with count of selected drops. */
        mergeBtnCount: (count: number) => string;
        /** State label: member neither survivor nor selected to merge. */
        leftAlone: string;
        /** Cluster header summary: total records · to-merge count. */
        clusterSummary: (total: number, toMerge: number) => string;
        /** Disabled-merge hint when no drop is selected. */
        selectAtLeastOne: string;
        /** Empty state when fewer than 2 entities were selected from the list. */
        selectAtLeastTwo: string;
        /** Review → confirm button (verify the merge consequences). */
        verifyMerge: string;
        /** List-page button: merge the N entities selected via checkboxes. */
        mergeSelected: (count: number) => string;
        selectedCount: (count: number) => string;
        clearSelection: string;
        selectRecord: (name: string) => string;
        selectPage: string;
        /** Final survivor name input (confirm step). */
        finalName: string;
        finalNamePlaceholder: string;
        /** Diff section headings (confirm step). */
        diffRecord: string;
        diffEvents: string;
        diffRelations: string;
        diffRag: string;
        diffRename: string;
        /** Record field verdicts. */
        fieldDiscarded: string;
        fieldKept: string;
        fieldDiffers: string;
        /** Diff counts. */
        eventsRepointed: (count: number) => string;
        relationsPreserved: (count: number) => string;
        relationRepointed: string;
        relationDeduplicated: string;
        ragWillDelete: (count: number) => string;
        ragWillConsolidate: (count: number) => string;
        ragWillRewrite: (count: number) => string;
        ragWillKeep: (count: number) => string;
        keptSeparate: string;
        /** Success report: survivor renamed. */
        reportRenamed: (from: string, to: string) => string;
    };
    bard: {
        title: string;
        navLabel: string;
        /** Empty state, before the first conversation exists. */
        intro: string;
        newConversation: string;
        conversations: string;
        noConversations: string;
        untitled: string;
        emptyThread: string;
        selectConversation: string;
        placeholder: string;
        send: string;
        /** Send button label with the price printed on it. */
        thinking: string;
        you: string;
        sharedBadge: string;
        sharedByOther: string;
        readOnly: string;
        share: string;
        unshare: string;
        rename: string;
        renameLabel: string;
        confirmRename: string;
        deleteConversation: string;
        deleteConfirm: (title: string) => string;
        /** Always-visible price line above the composer. */
        /** Provider and model the spend goes to, shown before sending. */
        costLine: (provider: string, model: string) => string;
        charged: (cost: string) => string;
        answeredBy: (model: string) => string;
        errorBusy: string;
        errorProvider: string;
    };
    campaignAdmin: {
        settingsTitle: string;
        settingsNav: string;
        name: string;
        language: string;
        languageHint: string;
        year: string;
        partyName: string;
        autoCharacterUpdate: string;
        autoCharacterUpdateHint: string;
        save: string;
        saved: string;
        membersTitle: string;
        /** Says out loud that this is the campaign's roster, not the Discord server's. */
        membersIntro: string;
        membersEmpty: string;
        roleMaster: string;
        rolePlayer: string;
        promote: string;
        demote: string;
        removeMember: string;
        removeMemberConfirm: (who: string) => string;
        masterOnly: string;
        noCharacter: string;
        /** Discord would not tell us who this id is. */
        unknownMember: string;
        /** Has a character in the campaign but holds no seat. */
        notEnrolled: string;
        notEnrolledHint: string;
        enroll: string;
        createTitle: string;
        createCta: string;
        createIntro: string;
        createSubmit: string;
        emptyCta: string;
    };
    characterSheet: {
        title: string;
        name: string;
        race: string;
        class: string;
        biography: string;
        biographyHint: string;
        save: string;
        create: string;
        none: string;
        manualBadge: string;
        regenerate: string;
        regenerateHint: string;
        noHistory: string;
        regenerated: string;
    };
    aiSettings: {
        title: string;
        nav: string;
        intro: string;
        notReady: string;
        ready: string;
        manageOnly: string;
        keysTitle: string;
        keysIntro: string;
        keyPlaceholder: string;
        keyConfigured: (hint: string) => string;
        keyMissing: string;
        /** Shown under a Gemini key: Google's free tier trains on what it receives. */
        freeTierTrainingWarning: string;
        saveKey: string;
        removeKey: string;
        removeKeyConfirm: (provider: string) => string;
        testKey: string;
        testOk: string;
        testAuthFailed: string;
        testQuotaExhausted: string;
        testUnreachable: string;
        testUndecryptable: string;
        localNoKey: string;
        modelsTitle: string;
        modelsIntro: string;
        tierQuality: string;
        tierQualityHint: string;
        tierFast: string;
        tierFastHint: string;
        provider: string;
        model: string;
        modelCustom: string;
        recommended: string;
        useDefault: string;
        save: string;
        saved: string;
        effectiveTitle: string;
        effectiveIntro: string;
        phase: string;
        campaignTitle: string;
        campaignIntro: string;
        manageLink: string;
        advancedTitle: string;
        advancedIntro: string;

        /**
         * Readable names for the nine pipeline phases.
         *
         * They used to be printed as raw ids — `narrativeFilter` — which asks
         * the reader to know the pipeline in order to configure it.
         *
         * ⚠️ `transcription` is the phase that **corrects** the transcript with
         * AI, not the one that turns audio into text: that is a different
         * setting entirely, and naming it "transcription" here would send
         * someone to change the wrong model.
         */
        phaseNames: {
            /** Audio→text. Not an AiPhase: an engine, billed per minute. */
            speechToText: string;
            transcription: string;
            metadata: string;
            map: string;
            analyst: string;
            summary: string;
            chat: string;
            narrativeFilter: string;
            reconcile: string;
            embedding: string;
            /** Drawing an entity's portrait, and the brief written for it first. */
            image: string;
            'image-prompt': string;
            manifesto: string;
            bio_batch: string;
            moral_reassessment: string;
        };
        providerNames: {
            openai: string;
            gemini: string;
            ollama: string;
        };
        /** Saved model that the refreshed catalogue no longer carries. */
        modelUnavailable: string;
        modelUnavailableHint: string;
        /** A rate we do not know. Never rendered as zero. */
        priceUnknown: string;
        onYourHardware: string;
        perMillionTokens: (input: string, output: string) => string;
        contextWindow: (tokens: string) => string;
        catalogRefreshed: (when: string) => string;
        catalogCurated: string;
        /** Cost of this phase alone, on a session of the given length. */
        estimateFor: (cost: string, hours: string) => string;
        estimateUnknown: string;
        estimateFree: string;
        estimateFromHistory: string;
        estimateFromDefaults: string;
        groupRecommended: string;
        groupOthers: string;
        /** The model that draws entity portraits, and its per-picture rate. */
        imageTitle: string;
        imageIntro: string;
        imageNone: string;
        perImage: (price: string) => string;
    };

    /** The transcription model for one campaign. The engine belongs to the server. */
    campaignTranscription: {
        title: string;
        intro: string;
        engine: string;
        engineRemote: string;
        engineCloud: string;
        engineNone: string;
        engineHint: string;
        model: string;
        followGuild: string;
        perMinute: (usd: string) => string;
        freeOnYourPc: string;
        pcOff: string;
        pcUnauthorized: string;
        notConfigured: string;
        noKey: string;
        save: string;
        saved: string;
    };
    transcription: {
        title: string;
        intro: string;
        engineRemote: string;
        engineRemoteHint: string;
        engineCloud: string;
        engineCloudHint: string;
        engineNone: string;
        notUsable: string;
        noCloudKey: string;
        machineUrl: string;
        machineUrlHint: string;
        authToken: string;
        authTokenHint: string;
        authTokenConfigured: string;
        test: string;
        wake: string;
        testOk: string;
        testUnreachable: string;
        testUnauthorized: string;
        testNotConfigured: string;
        shutdown: string;
        shutdownHint: string;
        wakeTitle: string;
        wakeIntro: string;
        wakeMethod: string;
        macAddress: string;
        macAddressHint: string;
        cloudModel: string;
        cloudModelHint: string;
        pricePerMinute: (usd: string) => string;
        priceUnknown: string;
        sessionEstimate: (hours: string, usd: string) => string;
        freeOnOwnMachine: string;
        save: string;
        saved: string;
    };
    summaryFlow: {
        title: string;
        intro: string;
        legacy: string;
        legacyHint: string;
        agentic: string;
        agenticHint: string;
        costWarning: string;
        save: string;
        saved: string;
    };
    embedding: {
        title: string;
        intro: string;
        currentModel: (model: string, fragments: string) => string;
        notIndexed: string;
        noOptions: string;
        change: string;
        estimate: (fragments: string, usd: string) => string;
        estimateFree: (fragments: string) => string;
        warning: string;
        reindex: string;
        reindexing: string;
        done: (reindexed: string) => string;
        partial: (failed: string) => string;
        free: string;
    };
    costs: {
        title: string;
        intro: string;
        sessionLength: string;
        total: (usd: string) => string;
        totalFree: string;
        incomplete: string;
        calibrated: string;
        notCalibrated: string;
        phase: string;
        tokens: string;
        tokensIn: string;
        tokensOut: string;
        cost: string;
        sourceBuiltin: string;
        sourceOverride: string;
        sourceFree: string;
        sourceSubscription: string;
        sourceUnknown: string;
        resourceIntensive: string;
        pricingTitle: string;
        pricingIntro: string;
        pricingModel: string;
        pricingInput: string;
        pricingOutput: string;
        /** Image models are billed per picture; the two per-token fields cannot express that. */
        pricingPerImage: string;
        pricingAdd: string;
        pricingRemove: string;
        save: string;
        saved: string;
    };
    legal: {
        title: string;
        intro: string;
        acceptTerms: string;
        acknowledgePrivacy: string;
        recordingWarning: string;
        continueLabel: string;
        updated: string;
        readTerms: string;
        readPrivacy: string;
    };
    /**
     * The «my data» page: a copy of it, or its erasure.
     *
     * Distinct from `legal`, which is about accepting documents. This is about
     * acting on what those documents describe — the rights Discord's Developer
     * Terms §5(b) require to be «easily accessible», and which existed only as
     * Discord commands before this page.
     */
    privacy: {
        nav: string;
        title: string;
        intro: string;
        exportTitle: string;
        exportBody: string;
        exportButton: string;
        eraseTitle: string;
        eraseBody: string;
        eraseButton: string;
        erasing: string;
        eraseConfirmQuestion: string;
        eraseConfirmConsequences: string;
        eraseDone: (rows: number, files: number) => string;
        erasePartial: string;
        readPolicy: string;
        readTerms: string;
    };
}
