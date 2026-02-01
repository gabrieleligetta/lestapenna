import { db } from './client';
export { db };

import { initDatabase } from './schema';
import { alignQuestStatuses } from './maintenance/questStatusAlignment';
import { alignEntityShortIds } from './maintenance/idAlignment';
try {
    initDatabase();
    alignQuestStatuses();
    alignEntityShortIds();
} catch (e) {
    console.error("[DB] Failed to initialize database schema or alignment:", e);
}

// Re-export types
export * from './types';

// Re-export utils
export * from './utils';

// Re-export schema (maintenance/init)
export { initDatabase };

// Import repositories
export { configRepository } from './repositories/ConfigRepository';
export { campaignRepository } from './repositories/CampaignRepository';
export { locationRepository } from './repositories/LocationRepository';
export { npcRepository } from './repositories/NpcRepository';
export { bestiaryRepository } from './repositories/BestiaryRepository';
export { questRepository } from './repositories/QuestRepository';
export { inventoryRepository } from './repositories/InventoryRepository';
export { characterRepository } from './repositories/CharacterRepository';
export { sessionRepository } from './repositories/SessionRepository';
export { recordingRepository } from './repositories/RecordingRepository';
export { knowledgeRepository } from './repositories/KnowledgeRepository';
export { chatRepository } from './repositories/ChatRepository';
export { pendingMergeRepository } from './repositories/PendingMergeRepository';
export { worldRepository } from './repositories/WorldRepository';
export { factionRepository } from './repositories/FactionRepository';
export { artifactRepository } from './repositories/ArtifactRepository';
export { eventRepository } from './repositories/EventRepository';
import { configRepository } from './repositories/ConfigRepository';
import { campaignRepository } from './repositories/CampaignRepository';
import { locationRepository } from './repositories/LocationRepository';
import { npcRepository } from './repositories/NpcRepository';
import { bestiaryRepository } from './repositories/BestiaryRepository';
import { questRepository } from './repositories/QuestRepository';
import { inventoryRepository } from './repositories/InventoryRepository';
import { characterRepository } from './repositories/CharacterRepository';
import { sessionRepository } from './repositories/SessionRepository';
import { recordingRepository } from './repositories/RecordingRepository';
import { knowledgeRepository } from './repositories/KnowledgeRepository';
import { chatRepository } from './repositories/ChatRepository';
import { pendingMergeRepository } from './repositories/PendingMergeRepository';
import { worldRepository } from './repositories/WorldRepository';
import { factionRepository } from './repositories/FactionRepository';
import { artifactRepository } from './repositories/ArtifactRepository';
import { wipeDatabase } from './maintenance';

// Re-export repository methods as top-level functions (Backward Compatibility)

// Config
export const setConfig = configRepository.setConfig;
export const getConfig = configRepository.getConfig;
export const getGuildConfig = configRepository.getGuildConfig;
export const setGuildConfig = configRepository.setGuildConfig;

// Campaign
export const createCampaign = campaignRepository.createCampaign;
export const getCampaigns = campaignRepository.getCampaigns;
export const getActiveCampaign = campaignRepository.getActiveCampaign;
export const setActiveCampaign = campaignRepository.setActiveCampaign;
export const updateCampaignLocation = campaignRepository.updateCampaignLocation;
export const setCampaignYear = campaignRepository.setCampaignYear;
export const setCampaignAutoUpdate = campaignRepository.setCampaignAutoUpdate;
export const getCampaignLocation = campaignRepository.getCampaignLocation;
export const getCampaignLocationById = campaignRepository.getCampaignLocationById;
export const getCampaignById = campaignRepository.getCampaignById;
export const deleteCampaign = campaignRepository.deleteCampaign;
export const getCampaignSnapshot = campaignRepository.getCampaignSnapshot;
export const getNextSessionNumber = campaignRepository.getNextSessionNumber;
export const updateLastSessionNumber = campaignRepository.updateLastSessionNumber;

// Location
export const updateLocation = locationRepository.updateLocation;
export const getLocationHistory = locationRepository.getLocationHistory;
export const getAtlasEntry = locationRepository.getAtlasEntry;
export const updateAtlasEntry = locationRepository.updateAtlasEntry;
export const listAtlasEntries = locationRepository.listAtlasEntries;
export const countAtlasEntries = locationRepository.countAtlasEntries;
export const listAllAtlasEntries = locationRepository.listAllAtlasEntries;
export const deleteAtlasEntry = locationRepository.deleteAtlasEntry;
export const getAtlasEntryFull = locationRepository.getAtlasEntryFull;
export const renameAtlasEntry = locationRepository.renameAtlasEntry;
export const mergeAtlasEntry = locationRepository.mergeAtlasEntry;
export const getLocationHistoryWithIds = locationRepository.getLocationHistoryWithIds;
export const fixLocationHistoryEntry = locationRepository.fixLocationHistoryEntry;
export const deleteLocationHistoryEntry = locationRepository.deleteLocationHistoryEntry;
export const fixCurrentLocation = locationRepository.fixCurrentLocation;
export const getDirtyAtlasEntries = locationRepository.getDirtyAtlasEntries;
export const clearAtlasDirtyFlag = locationRepository.clearAtlasDirtyFlag;
export const markAtlasDirty = locationRepository.markAtlasDirty;
export const getSessionTravelLog = locationRepository.getSessionTravelLog;
export const clearSessionLocationHistory = locationRepository.clearSessionLocationHistory;
export const addAtlasEvent = locationRepository.addAtlasEvent;
export const getAtlasHistory = locationRepository.getAtlasHistory;
export const getAtlasEntryByShortId = locationRepository.getAtlasEntryByShortId;

// NPC
// NPC
export const updateNpcEntry = npcRepository.updateNpcEntry;
export const getNpcEntry = npcRepository.getNpcEntry;
export const listNpcs = npcRepository.listNpcs;
export const countNpcs = npcRepository.countNpcs;
export const addNpcEvent = npcRepository.addNpcEvent;
export const getAllNpcs = npcRepository.getAllNpcs;
export const getDirtyNpcDossiers = npcRepository.getDirtyNpcDossiers;
export const getDirtyNpcs = npcRepository.getDirtyNpcDossiers; // ALIAS
export const clearNpcDirtyFlag = npcRepository.clearNpcDirtyFlag;
export const markNpcDirty = npcRepository.markNpcDirty;
export const getNpcByAlias = npcRepository.getNpcByAlias;
export const getNpcByNameOrAlias = npcRepository.getNpcByAlias; // ALIAS
export const addNpcAlias = npcRepository.addNpcAlias;
export const removeNpcAlias = npcRepository.removeNpcAlias;
export const updateNpcAliases = npcRepository.updateNpcAliases;
export const updateNpcFields = npcRepository.updateNpcFields;
export const renameNpcEntry = npcRepository.renameNpcEntry;
export const deleteNpcEntry = npcRepository.deleteNpcEntry;
export const deleteNpcHistory = npcRepository.deleteNpcHistory;
export const getSessionEncounteredNPCs = npcRepository.getSessionEncounteredNPCs;
export const getNpcHistory = npcRepository.getNpcHistory;
export const findNpcDossierByName = npcRepository.findNpcDossierByName;
export const getNpcIdByName = npcRepository.getNpcIdByName;
export const getNpcNameById = npcRepository.getNpcNameById;
export const getNpcByShortId = npcRepository.getNpcByShortId;

// Bestiary
export const upsertMonster = bestiaryRepository.upsertMonster;
export const listAllMonsters = bestiaryRepository.listAllMonsters;
export const getMonsterByName = bestiaryRepository.getMonsterByName;
export const mergeMonsters = bestiaryRepository.mergeMonsters;
export const listMonsters = bestiaryRepository.listMonsters;
export const getSessionMonsters = bestiaryRepository.getSessionMonsters;
export const addBestiaryEvent = bestiaryRepository.addBestiaryEvent;
export const getBestiaryHistory = bestiaryRepository.getBestiaryHistory;
export const getDirtyBestiaryEntries = bestiaryRepository.getDirtyBestiaryEntries;
export const clearBestiaryDirtyFlag = bestiaryRepository.clearBestiaryDirtyFlag;
export const getMonsterByShortId = bestiaryRepository.getMonsterByShortId;
export const deleteMonster = bestiaryRepository.deleteMonster;

// Quest
export const addQuest = questRepository.addQuest;
export const getSessionQuests = questRepository.getSessionQuests;
export const updateQuestStatus = questRepository.updateQuestStatus;
export const updateQuestStatusById = questRepository.updateQuestStatusById;
export const deleteQuest = questRepository.deleteQuest;
export const getOpenQuests = questRepository.getOpenQuests;
export const listAllQuests = questRepository.listAllQuests;
export const getQuestByTitle = questRepository.getQuestByTitle;
export const mergeQuests = questRepository.mergeQuests;
export const addQuestEvent = questRepository.addQuestEvent;
export const getQuestHistory = questRepository.getQuestHistory;
export const getDirtyQuests = questRepository.getDirtyQuests;
export const clearQuestDirtyFlag = questRepository.clearQuestDirtyFlag;
export const getQuestByShortId = questRepository.getQuestByShortId;
export const markQuestDirty = questRepository.markQuestDirty;

// Inventory
export const addLoot = inventoryRepository.addLoot;
export const removeLoot = inventoryRepository.removeLoot;
export const getInventory = inventoryRepository.getInventory;
export const getSessionInventory = inventoryRepository.getSessionInventory;
export const listAllInventory = inventoryRepository.listAllInventory;
export const getInventoryItemByName = inventoryRepository.getInventoryItemByName;
export const mergeInventoryItems = inventoryRepository.mergeInventoryItems;
export const addInventoryEvent = inventoryRepository.addInventoryEvent;
export const getInventoryHistory = inventoryRepository.getInventoryHistory;
export const getDirtyInventoryItems = inventoryRepository.getDirtyInventoryItems;
export const clearInventoryDirtyFlag = inventoryRepository.clearInventoryDirtyFlag;
export const getInventoryItemByShortId = inventoryRepository.getInventoryItemByShortId;
export const markInventoryDirty = inventoryRepository.markInventoryDirty;
export const deleteInventoryHistory = inventoryRepository.deleteInventoryHistory;

// Character
export const addCharacterEvent = characterRepository.addCharacterEvent;
export const getCharacterHistory = characterRepository.getCharacterHistory;
export const getNewCharacterHistory = characterRepository.getNewCharacterHistory;
export const updateCharacterLastSyncedHistoryId = characterRepository.updateCharacterLastSyncedHistoryId;
export const getCharacterUserId = characterRepository.getCharacterUserId;
export const getUserProfile = characterRepository.getUserProfile;
export const getUserName = characterRepository.getUserName;
export const getCampaignCharacters = characterRepository.getCampaignCharacters;
export const updateUserCharacter = characterRepository.updateUserCharacter;
export const deleteUserCharacter = characterRepository.deleteUserCharacter;
export const markCharacterDirtyByName = characterRepository.markCharacterDirtyByName;
export const getDirtyCharacters = characterRepository.getDirtyCharacters;
export const markCharacterDirty = characterRepository.markCharacterDirty;
export const clearCharacterDirtyFlag = characterRepository.clearCharacterDirtyFlag;

// Session
export const getAvailableSessions = sessionRepository.getAvailableSessions;
export const getExplicitSessionNumber = sessionRepository.getExplicitSessionNumber;
export const setSessionNumber = sessionRepository.setSessionNumber;
export const updateSessionTitle = sessionRepository.updateSessionTitle;
export const createSession = sessionRepository.createSession;
export const getSessionAuthor = sessionRepository.getSessionAuthor;
export const getSessionStartTime = sessionRepository.getSessionStartTime;
export const getSessionCampaignId = sessionRepository.getSessionCampaignId;
export const getSessionGuildId = sessionRepository.getSessionGuildId;
export const findSessionByTimestamp = sessionRepository.findSessionByTimestamp;
export const addSessionNote = sessionRepository.addSessionNote;
export const getSessionNotes = sessionRepository.getSessionNotes;
export const clearSessionDerivedData = sessionRepository.clearSessionDerivedData;
export const addSessionLog = sessionRepository.addSessionLog;
export const getSessionLog = sessionRepository.getSessionLog;
export const saveSessionAIOutput = sessionRepository.saveSessionAIOutput;
export const getSessionAIOutput = sessionRepository.getSessionAIOutput;

// Recording
export const addRecording = recordingRepository.addRecording;
export const getSessionRecordings = recordingRepository.getSessionRecordings;
export const getRecording = recordingRepository.getRecording;
export const updateRecordingStatus = recordingRepository.updateRecordingStatus;
export const saveRawTranscription = recordingRepository.saveRawTranscription;
export const updateSessionPresentNPCs = recordingRepository.updateSessionPresentNPCs;
export const getUnprocessedRecordings = recordingRepository.getUnprocessedRecordings;
export const resetSessionData = recordingRepository.resetSessionData;
export const resetUnfinishedRecordings = recordingRepository.resetUnfinishedRecordings;
export const getSessionTranscript = recordingRepository.getSessionTranscript;
export const getSessionErrors = recordingRepository.getSessionErrors;

// Knowledge
// Knowledge
export const insertKnowledgeFragment = knowledgeRepository.insertKnowledgeFragment;
export const getKnowledgeFragments = knowledgeRepository.getKnowledgeFragments;
export const deleteSessionKnowledge = knowledgeRepository.deleteSessionKnowledge;
export const migrateKnowledgeFragments = knowledgeRepository.migrateKnowledgeFragments;
export const migrateRagNpcReferences = knowledgeRepository.migrateRagNpcReferences;
export const deleteNpcRagSummary = knowledgeRepository.deleteNpcRagSummary;
// Location
export const deleteAtlasHistory = locationRepository.deleteAtlasHistory; // 🆕

// Quest
export const deleteQuestHistory = questRepository.deleteQuestHistory; // 🆕
export const deleteQuestRagSummary = knowledgeRepository.deleteQuestRagSummary; // 🆕

// Inventory
export const deleteInventoryRagSummary = knowledgeRepository.deleteInventoryRagSummary; // 🆕
export const deleteAtlasRagSummary = knowledgeRepository.deleteAtlasRagSummary;
export const deleteBestiaryRagSummary = knowledgeRepository.deleteBestiaryRagSummary; // 🆕

// Chat
export const addChatMessage = chatRepository.addChatMessage;
export const getChatHistory = chatRepository.getChatHistory;

// Pending Merges
export const addPendingMerge = pendingMergeRepository.addPendingMerge;
export const removePendingMerge = pendingMergeRepository.removePendingMerge;
export const getAllPendingMerges = pendingMergeRepository.getAllPendingMerges;

// World
export const addWorldEvent = worldRepository.addWorldEvent;
export const getWorldTimeline = worldRepository.getWorldTimeline;
export const deleteWorldEvent = worldRepository.deleteWorldEvent;
export const getDirtyWorldEvents = worldRepository.getDirtyWorldEvents;
export const clearWorldEventDirtyFlag = worldRepository.clearWorldEventDirtyFlag;
export const getWorldEventByShortId = worldRepository.getWorldEventByShortId;
export const updateWorldEvent = worldRepository.updateWorldEvent;
export const markWorldEventDirty = worldRepository.markWorldEventDirty;

// Faction
export const createFaction = factionRepository.createFaction;
export const getFaction = factionRepository.getFaction;
export const getFactionById = factionRepository.getFactionById;
export const listFactions = factionRepository.listFactions;
export const updateFaction = factionRepository.updateFaction;
export const deleteFaction = factionRepository.deleteFaction;
export const renameFaction = factionRepository.renameFaction;
export const getPartyFaction = factionRepository.getPartyFaction;
export const createPartyFaction = factionRepository.createPartyFaction;
export const renamePartyFaction = factionRepository.renamePartyFaction;
export const setFactionReputation = factionRepository.setFactionReputation;
export const getFactionReputation = factionRepository.getFactionReputation;
export const getReputationWithAllFactions = factionRepository.getReputationWithAllFactions;
export const adjustReputation = factionRepository.adjustReputation;
export const addAffiliation = factionRepository.addAffiliation;
export const removeAffiliation = factionRepository.removeAffiliation;
export const getEntityFactions = factionRepository.getEntityFactions;
export const getFactionMembers = factionRepository.getFactionMembers;
export const addFactionEvent = factionRepository.addFactionEvent;
export const getFactionHistory = factionRepository.getFactionHistory;
export const markFactionDirty = factionRepository.markFactionDirty;
export const getDirtyFactions = factionRepository.getDirtyFactions;
export const clearFactionDirtyFlag = factionRepository.clearFactionDirtyFlag;

// Artifact
export const upsertArtifact = artifactRepository.upsertArtifact;
export const getArtifactByName = artifactRepository.getArtifactByName;
export const getArtifactByShortId = artifactRepository.getArtifactByShortId;
export const listAllArtifacts = artifactRepository.listAllArtifacts;
export const listArtifacts = artifactRepository.listArtifacts;
export const deleteArtifact = artifactRepository.deleteArtifact;
export const addArtifactEvent = artifactRepository.addArtifactEvent;
export const getArtifactHistory = artifactRepository.getArtifactHistory;
export const markArtifactDirty = artifactRepository.markArtifactDirty;
export const getDirtyArtifacts = artifactRepository.getDirtyArtifacts;
export const clearArtifactDirtyFlag = artifactRepository.clearArtifactDirtyFlag;
export const mergeArtifacts = artifactRepository.mergeArtifacts;
export const updateArtifactFields = artifactRepository.updateArtifactFields;

// Maintenance
export { wipeDatabase };
