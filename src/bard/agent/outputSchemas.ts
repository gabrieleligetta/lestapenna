/**
 * JSON Schema definitions for Anthropic Structured Outputs (`output_config.format`).
 *
 * These schemas are passed to the Anthropic Messages API to guarantee valid JSON output.
 * The SDK (@anthropic-ai/sdk ^0.111.0) auto-transforms unsupported constraints
 * (minLength, minimum, etc.) into descriptions before sending to the API.
 *
 * NOTE: `additionalProperties: false` is REQUIRED by the Anthropic API for all objects.
 */

/**
 * Makes every property of every object in the schema "required" (keys that were
 * originally optional become nullable, `type: [type, 'null']`, so the model can return
 * `null` instead of inventing a value). The schemas below are written with a partial
 * `required` (tolerated by Gemini), so this transformation must only be applied by the
 * providers that do NOT tolerate it — verified with real API errors:
 * - **OpenAI** strict mode: 400 "'required' is required to be supplied and to be an
 *   array including every key in properties" (every key of `properties` has to be in
 *   `required`, full stop).
 * - **Anthropic** Structured Outputs: 400 "Schemas contains too many optional parameters
 *   (56) [...] limit: 24" — ANALYST_OUTPUT_SCHEMA has ~56 optional properties across its
 *   nested objects, well beyond the documented limit of 24 total optional parameters.
 *   Zeroing the optionals (everything required+nullable) fixes that too, as a side effect.
 */
export function toFullyRequiredJsonSchema(node: any): any {
    if (Array.isArray(node)) return node.map(toFullyRequiredJsonSchema);
    if (!node || typeof node !== 'object') return node;

    const out: any = {};
    for (const [key, value] of Object.entries(node)) {
        out[key] = toFullyRequiredJsonSchema(value);
    }

    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
        const originalRequired: string[] = Array.isArray(out.required) ? out.required : [];
        for (const key of Object.keys(out.properties)) {
            if (originalRequired.includes(key)) continue;
            const prop = out.properties[key];
            if (!prop || typeof prop !== 'object') continue;
            if (prop.enum !== undefined || prop.const !== undefined) {
                // type array + enum is not reliable: Anthropic rejects with a 400 "Enum
                // value [...] does not match declared type ['string','null']" even after
                // adding null to the enum itself — the validator does not reconcile the two.
                // anyOf isolates the original enum/const from the nullability, working
                // around the problem (it also works on OpenAI, which supports anyOf).
                out.properties[key] = { anyOf: [prop, { type: 'null' }] };
            } else if (Array.isArray(prop.type)) {
                if (!prop.type.includes('null')) prop.type = [...prop.type, 'null'];
            } else if (typeof prop.type === 'string') {
                prop.type = [prop.type, 'null'];
            }
        }
        out.required = Object.keys(out.properties);
    }

    return out;
}

/**
 * Schema for the Analyst phase output (AnalystOutput in types.ts).
 *
 * NOT usable with Anthropic Structured Outputs (output_config.format) as it stands: it
 * simultaneously exceeds the limit of 24 optional parameters and the separate, stricter
 * limit of 16 "union-typed" (nullable) parameters — no transformation of the schema satisfies
 * both limits together (making it all required+nullable to stay under the 24 optionals
 * pushes it well past the 16 union-typed ones). Verified with real API errors on 2026-07-12 — see
 * agentic-model-tests/LEADERBOARD.md and runs/2026-07-12_claude-sonnet-5_semi-agentic-cloud-e2e/README.md.
 * Claude Sonnet 5/Anthropic is therefore excluded as an Analyst provider for this pipeline until
 * this schema is split into several smaller ones. WRITER_OUTPUT_SCHEMA on the other hand (few
 * properties) stays compatible with Anthropic without trouble.
 */
export const ANALYST_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        loot: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    name: { type: 'string' as const },
                    quantity: { type: 'integer' as const },
                    description: { type: 'string' as const },
                    category: { type: 'string' as const, enum: ['WEAPON', 'ARMOR', 'CONSUMABLE', 'TOOL', 'MATERIAL', 'TREASURE', 'QUEST_ITEM', 'OTHER'] }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        loot_removed: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    name: { type: 'string' as const },
                    quantity: { type: 'integer' as const },
                    description: { type: 'string' as const }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        quests: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    title: { type: 'string' as const },
                    description: { type: 'string' as const },
                    status: { type: 'string' as const, enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] },
                    type: { type: 'string' as const, enum: ['MAJOR', 'MINOR'] }
                },
                required: ['title'],
                additionalProperties: false
            }
        },
        monsters: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    name: { type: 'string' as const },
                    status: { type: 'string' as const },
                    description: { type: 'string' as const },
                    abilities: { type: 'array' as const, items: { type: 'string' as const } },
                    weaknesses: { type: 'array' as const, items: { type: 'string' as const } },
                    resistances: { type: 'array' as const, items: { type: 'string' as const } }
                },
                required: ['name', 'status'],
                additionalProperties: false
            }
        },
        npc_dossier_updates: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    description: { type: 'string' as const },
                    role: { type: 'string' as const },
                    status: { type: 'string' as const, enum: ['ALIVE', 'DEAD', 'MISSING'] },
                    alignment_moral: { type: 'string' as const, enum: ['GOOD', 'NEUTRAL', 'EVIL'] },
                    alignment_ethical: { type: 'string' as const, enum: ['LAWFUL', 'NEUTRAL', 'CHAOTIC'] }
                },
                required: ['name', 'description'],
                additionalProperties: false
            }
        },
        location_updates: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    macro: { type: 'string' as const },
                    micro: { type: 'string' as const },
                    description: { type: 'string' as const }
                },
                required: ['macro', 'micro', 'description'],
                additionalProperties: false
            }
        },
        travel_sequence: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    macro: { type: 'string' as const },
                    micro: { type: 'string' as const },
                    reason: { type: 'string' as const }
                },
                required: ['macro', 'micro'],
                additionalProperties: false
            }
        },
        present_npcs: {
            type: 'array' as const,
            items: { type: 'string' as const }
        },
        npc_locations: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    name: { type: 'string' as const },
                    location_id: { type: 'string' as const },
                    macro: { type: 'string' as const },
                    micro: { type: 'string' as const }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        log: {
            type: 'array' as const,
            items: { type: 'string' as const }
        },
        character_growth: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    event: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['BACKGROUND', 'TRAUMA', 'RELATIONSHIP', 'ACHIEVEMENT', 'GOAL_CHANGE'] },
                    moral_impact: { type: 'integer' as const },
                    ethical_impact: { type: 'integer' as const },
                    faction_id: { type: 'string' as const }
                },
                required: ['name', 'event', 'type'],
                additionalProperties: false
            }
        },
        npc_events: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    event: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['FIRST_APPEARANCE', 'REVELATION', 'BETRAYAL', 'DEATH', 'ALLIANCE', 'STATUS_CHANGE', 'COMBAT', 'INTERACTION', 'ABILITY_REVEALED', 'GENERIC'] },
                    moral_impact: { type: 'integer' as const },
                    ethical_impact: { type: 'integer' as const },
                    faction_id: { type: 'string' as const }
                },
                required: ['name', 'event', 'type'],
                additionalProperties: false
            }
        },
        world_events: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    event: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'SUPERNATURAL', 'GENERIC', 'DISASTER', 'MYTH', 'RELIGION', 'BIRTH', 'DEATH', 'CONSTRUCTION'] }
                },
                required: ['event', 'type'],
                additionalProperties: false
            }
        },
        faction_updates: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    description: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC'] },
                    alignment_moral: { type: 'string' as const, enum: ['GOOD', 'NEUTRAL', 'EVIL'] },
                    alignment_ethical: { type: 'string' as const, enum: ['LAWFUL', 'NEUTRAL', 'CHAOTIC'] },
                    reputation_change: {
                        type: 'object' as const,
                        properties: {
                            value: { type: 'integer' as const },
                            reason: { type: 'string' as const }
                        },
                        required: ['value', 'reason'],
                        additionalProperties: false
                    }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        faction_affiliations: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    entity_id: { type: 'string' as const },
                    entity_type: { type: 'string' as const, enum: ['npc', 'location'] },
                    entity_name: { type: 'string' as const },
                    faction_id: { type: 'string' as const },
                    faction_name: { type: 'string' as const },
                    role: { type: 'string' as const, enum: ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED', 'HQ', 'PRESENCE', 'HOSTILE', 'PRISONER'] },
                    action: { type: 'string' as const, enum: ['JOIN', 'LEAVE'] }
                },
                required: ['entity_type', 'entity_name', 'faction_name', 'action'],
                additionalProperties: false
            }
        },
        party_alignment_change: {
            type: 'object' as const,
            properties: {
                id: { type: 'string' as const },
                moral_impact: { type: 'integer' as const },
                ethical_impact: { type: 'integer' as const },
                reason: { type: 'string' as const }
            },
            required: ['reason'],
            additionalProperties: false
        },
        artifacts: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    description: { type: 'string' as const },
                    effects: { type: 'string' as const },
                    is_cursed: { type: 'boolean' as const },
                    curse_description: { type: 'string' as const },
                    owner_type: { type: 'string' as const, enum: ['PC', 'NPC', 'FACTION', 'LOCATION', 'NONE'] },
                    owner_name: { type: 'string' as const },
                    location_macro: { type: 'string' as const },
                    location_micro: { type: 'string' as const },
                    faction_name: { type: 'string' as const },
                    status: { type: 'string' as const, enum: ['FUNCTIONAL', 'DESTROYED', 'LOST', 'SEALED', 'DORMANT'] }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        artifact_events: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    name: { type: 'string' as const },
                    event: { type: 'string' as const },
                    type: { type: 'string' as const, enum: ['ACTIVATION', 'DESTRUCTION', 'TRANSFER', 'REVELATION', 'CURSE', 'GENERIC', 'DISCOVERY', 'CURSE_REVEAL', 'OBSERVATION', 'MANUAL_UPDATE'] }
                },
                required: ['name', 'event', 'type'],
                additionalProperties: false
            }
        }
    },
    required: [
        'loot', 'loot_removed', 'quests', 'monsters',
        'npc_dossier_updates', 'location_updates', 'travel_sequence',
        'present_npcs', 'npc_locations', 'log', 'character_growth',
        'npc_events', 'world_events', 'faction_updates',
        'faction_affiliations', 'artifacts', 'artifact_events'
    ],
    additionalProperties: false
} as const;

/**
 * Schema for askBard's agentic final-answer step (bounded tool-calling layer).
 *
 * `grounded` and `missing` are not telemetry: they are the shape that lets the
 * model decline. With a single `answer` string there is nowhere to put «the
 * records do not say», so an answer gets written anyway — that is how a question
 * about an NPC's looks came back as a tiefling with ram horns for a subject
 * whose dossier holds no physical detail at all. A prohibition in the prompt
 * competes with the instruction to answer; a field costs nothing to fill.
 */
export const ASK_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        answer: { type: 'string' as const },
        /** False when any part of the answer is not held in the material or the tools. */
        grounded: { type: 'boolean' as const },
        /** What was asked for and genuinely is not in this campaign's records. */
        missing: { type: 'array' as const, items: { type: 'string' as const } }
    },
    required: ['answer'],
    additionalProperties: false
} as const;

/**
 * Schema for the appearance analysis.
 *
 * Deliberately a **flat list of traits** rather than one nested object per kind
 * of subject. Three reasons, in order of importance:
 *
 * 1. The evidence is a sibling of the value, so the schema itself makes an
 *    unevidenced trait unrepresentable. A nested object would have let a model
 *    fill `hair.colour` out of nowhere and leave the evidence elsewhere, which
 *    is precisely the failure this whole feature exists to stop.
 * 2. One schema covers people, places and objects; what changes between them is
 *    the vocabulary of `field`, which belongs in the prompt rather than in a
 *    third copy of the same structure.
 * 3. Few properties, so it stays inside the provider limits that
 *    ANALYST_OUTPUT_SCHEMA famously does not (see the note on it above).
 *
 * `not_recorded` is the other half of honesty: the list of things that were
 * looked for and are genuinely absent from the campaign's material.
 */
export const APPEARANCE_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        traits: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    field: { type: 'string' as const },
                    value: { type: 'string' as const },
                    evidence: { type: 'string' as const },
                    source: {
                        type: 'string' as const,
                        enum: ['sheet', 'history', 'faction', 'transcript', 'rag'],
                    },
                    session: { type: 'string' as const },
                    confidence: { type: 'string' as const, enum: ['HIGH', 'MEDIUM', 'LOW'] },
                },
                required: ['field', 'value', 'evidence', 'source', 'confidence'],
                additionalProperties: false,
            },
        },
        personality: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    field: { type: 'string' as const, enum: ['temperament', 'manner', 'voice'] },
                    value: { type: 'string' as const },
                    evidence: { type: 'string' as const },
                    source: {
                        type: 'string' as const,
                        enum: ['sheet', 'history', 'faction', 'transcript', 'rag'],
                    },
                    session: { type: 'string' as const },
                    confidence: { type: 'string' as const, enum: ['HIGH', 'MEDIUM', 'LOW'] },
                },
                required: ['field', 'value', 'evidence', 'source', 'confidence'],
                additionalProperties: false,
            },
        },
        not_recorded: {
            type: 'array' as const,
            items: { type: 'string' as const },
        },
    },
    required: ['traits', 'personality', 'not_recorded'],
    additionalProperties: false,
} as const;

/** Schema for the Writer phase output (narrative + metadata). */
export const WRITER_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        title: { type: 'string' as const },
        narrative: { type: 'string' as const },
        narrativeBrief: { type: 'string' as const },
        metadata: {
            type: 'object' as const,
            properties: {
                tone: { type: 'string' as const },
                actNumber: { type: 'integer' as const },
                totalActs: { type: 'integer' as const }
            },
            additionalProperties: false
        }
    },
    required: ['title', 'narrative'],
    additionalProperties: false
} as const;
