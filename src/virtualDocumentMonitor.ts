import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Database } from 'sqlite3';
import { ChatLogger, Conversation, ChatMessage } from './chatLogger';

export class VirtualDocumentMonitor implements vscode.Disposable {
    private chatLogger: ChatLogger;
    private disposables: vscode.Disposable[] = [];
    private config: any;
    private timer: NodeJS.Timeout | null = null;
    private isCheckingForChanges = false;
    private db: Database | null = null;
    private lastProcessedComposerIds = new Map<string, Set<string>>();
    private currentLogLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';

    constructor(chatLogger: ChatLogger) {
        this.chatLogger = chatLogger;
        this.loadConfiguration();
    }

    private loadConfiguration() {
        const config = vscode.workspace.getConfiguration('chatlogger');
        this.config = {
            autoSave: config.get('autoSave.enabled', true),
            ignoreCodeOutput: config.get('ignoreCodeOutput', true),
            checkInterval: config.get('checkInterval', 30000) // 30 seconds
        };
    }

    public updateConfiguration() {
        this.loadConfiguration();
    }

    public start(): void {
        if (!this.config.autoSave) {
            this.log('info', 'Auto-save is disabled, not starting monitor');
            return;
        }

        this.initializeDatabase();
        this.startPeriodicCheck();
        this.log('info', 'VirtualDocumentMonitor started and monitoring Cursor conversations.');
    }

    private getCursorStoragePath(): string {
        // Windows path: C:\Users\{username}\AppData\Roaming\Cursor\User\globalStorage
        const username = os.userInfo().username;
        return path.join('C:', 'Users', username, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage');
    }

    private getCursorDatabasePath(): string {
        const cursorStoragePath = this.getCursorStoragePath();
        return path.join(cursorStoragePath, 'state.vscdb');
    }

    private getCurrentWorkspacePath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return null;
    }

    private isSameWorkspace(conversationWorkspacePath: string, currentWorkspacePath: string): boolean {
        // Normalize paths for comparison
        const normalizedConversationPath = path.normalize(conversationWorkspacePath);
        const normalizedCurrentPath = path.normalize(currentWorkspacePath);
        
        // Check if conversation workspace is the same as current workspace
        return normalizedConversationPath === normalizedCurrentPath;
    }

    private initializeDatabase(): void {
        try {
            const dbPath = this.getCursorDatabasePath();
            if (!fs.existsSync(dbPath)) {
                this.log('info', `Cursor database does not exist: ${dbPath}`);
                return;
            }
            this.db = new Database(dbPath, (err) => {
                if (err) {
                    this.log('error', `Failed to initialize database: ${err}`);
                } else {
                    this.log('info', `Database connection established: ${dbPath}`);
                }
            });
        } catch (error) {
            this.log('error', `Failed to initialize database: ${error}`);
        }
    }

    private startPeriodicCheck(): void {
        this.log('info', `Starting periodic check (interval: ${this.config.checkInterval}ms)`);
        this.timer = setInterval(() => {
            this.log('info', 'Timer triggered - checking for new conversations...');
            this.checkForChanges('periodic');
        }, this.config.checkInterval);
        // Only log once
    }

    private async checkForChanges(trigger: string): Promise<void> {        
        if (this.isCheckingForChanges) {
            this.log('info', 'Already checking for changes, skipping...');
            return;
        }
        
        if (!this.db) {
            this.log('info', 'Database not initialized, skipping...');
            return;
        }

        this.isCheckingForChanges = true;

        try {            
            const conversations = await this.loadConversationsFromDatabase();
            
            for (const conversation of conversations) {
                if (!conversation) continue;
                this.chatLogger.addConversation(conversation);
                
                // Auto-save if enabled
                if (this.config.autoSave) {
                    await this.chatLogger.saveConversation(conversation);
                }
            }
        } catch (error) {
            this.log('error', `Error checking for changes: ${error}`);
        } finally {
            this.isCheckingForChanges = false;
        }
    }

    private async loadConversationsFromDatabase(): Promise<Conversation[]> {
        return new Promise(async (resolve) => {
            try {
                if (!this.db) {
                    resolve([]);
                    return;
                }

                const conversations: Conversation[] = [];

                // Query the cursorDiskKV table for conversation data
                this.db.all(`
                    SELECT key, value 
                    FROM cursorDiskKV 
                    WHERE key LIKE '%composer%' 
                    ORDER BY key
                `, async (err, rows: Array<{ key: string; value: string }>) => {
                    if (err) {
                        this.log('error', `Error loading conversations from database: ${err}`);
                        resolve([]);
                        return;
                    }

                    for (const row of rows) {
                        try {
                            const data = JSON.parse(row.value);
                            const conversation = await this.parseConversationData(data, row.key);
                            if (conversation) {
                                conversations.push(conversation);
                            }
                        } catch (error) {
                            this.log('error', `Error parsing conversation data from key ${row.key}: ${error}`);
                        }
                    }

                    resolve(conversations);
                });
            } catch (error) {
                this.log('error', `Error loading conversations from database: ${error}`);
                resolve([]);
            }
        });
    }

    private async parseConversationData(data: any, key: string): Promise<Conversation | null> {
        try {
            let conversationTitle = 'Cursor Chat Conversation';
            let composerId: string | undefined;
            let sessionId: string | undefined;
            let workspacePath: string | undefined;

            composerId = this.extractComposerIdFromKey(key);
            if (!composerId) {
                this.log('info', 'No composer ID found in key, cannot extract messages');
                return null;
            }

            // Get all bubble IDs from the composer data
            const bubbleIds = this.extractBubbleIdsFromComposerData(data);
            if (bubbleIds.length === 0) {
                this.log('debug', 'No bubble IDs found in composer data for message extraction');
                return null;
            }

            // Deduplication: skip if all bubbleIds are already processed
            const processedSet = this.lastProcessedComposerIds.get(composerId) || new Set();
            const newBubbleIds = bubbleIds.filter(bid => !processedSet.has(bid));
            if (newBubbleIds.length === 0) {
                this.log('debug', `[ChatLogger] Skipping already processed composer and bubbleIds in parseConversationData: ${composerId}`);
                return null;
            }

            // Get current workspace path for filtering
            const currentWorkspacePath = this.getCurrentWorkspacePath();
            if (!currentWorkspacePath) {
                this.log('debug', 'No workspace open, skipping conversation');
                return null;
            }

            // Extract workspace information from the data structure
            workspacePath = await this.extractWorkspacePathFromData(data, key);
            
            if (!workspacePath) {
                this.log('debug', 'No workspace path found in conversation data, skipping.');
                return null;
            }

            // Check if this conversation belongs to the current workspace
            if (!this.isSameWorkspace(workspacePath, currentWorkspacePath)) {
                this.log('debug', `Skipping conversation: workspace ${workspacePath} not matching current workspace ${currentWorkspacePath}`);
                return null;
            }
            
            this.log('debug', `Accepted conversation: workspace ${workspacePath} matches current workspace ${currentWorkspacePath}`);

            // --- NEW LOGIC: Build messages from new bubble data only ---
            const messages: ChatMessage[] = [];
            for (const bubbleId of newBubbleIds) {
                const bubbleKey = `bubbleId:${composerId}:${bubbleId}`;
                const bubbleData = await this.getBubbleData(bubbleKey);
                if (bubbleData && bubbleData.type && (bubbleData.text || bubbleData.content)) {
                    const role = this.mapMessageTypeToRole(bubbleData.type);
                    if (role) {
                        const text = bubbleData.text || bubbleData.content;
                        const timestamp = new Date();
                        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        const { filteredContent, metadata } = this.filterMessageContent(text, role);
                        messages.push({
                            id: messageId,
                            bubbleId,
                            timestamp,
                            role,
                            content: text,
                            filteredContent,
                            metadata
                        });
                    }
                }
            }

            // Mark these bubbleIds as processed for this composerId
            if (newBubbleIds.length > 0) {
                if (!this.lastProcessedComposerIds.has(composerId)) {
                    this.lastProcessedComposerIds.set(composerId, new Set());
                }
                const set = this.lastProcessedComposerIds.get(composerId)!;
                for (const bubbleId of newBubbleIds) {
                    set.add(bubbleId);
                }
            }

            if (messages.length === 0) {
                return null;
            }

            // Use the composer name or fallback title
            if (data.composerId) {
                conversationTitle = data.name || `Composer ${data.composerId}`;
            } else if (data.sessionId) {
                sessionId = data.sessionId;
                conversationTitle = data.title || `Session ${sessionId}`;
            }

            return this.createConversation(conversationTitle, messages, data, key, workspacePath);
        } catch (error) {
            this.log('debug', `Failed parsing conversation data: ${error}`);
            return null;
        }
    }

    private async extractWorkspacePathFromData(data: any, key: string): Promise<string | undefined> {
        try {
            // Extract composer ID from the key
            const composerId = this.extractComposerIdFromKey(key);
            if (!composerId) {
                this.log('info', 'No composer ID found in key, cannot extract workspace path');
                return undefined;
            }

            // Get all bubble IDs from the composer data
            const bubbleIds = this.extractBubbleIdsFromComposerData(data);
            if (bubbleIds.length === 0) {
                this.log('debug', 'No bubble IDs found in composer data');
                return undefined;
            }

            // Query messageRequestContext for each bubble
            const messageRequestContexts = await this.getAllMessageRequestContexts(composerId, bubbleIds);
            
            // Check each messageRequestContext for projectLayouts
            for (const contextData of messageRequestContexts) {
                if (contextData.projectLayouts && Array.isArray(contextData.projectLayouts)) {
                    for (const layout of contextData.projectLayouts) {
                        try {
                            const layoutData = JSON.parse(layout);
                            if (layoutData.rootPath) {
                                // Found workspace name, now look up the actual path
                                const workspacePath = this.getWorkspacePathFromName(layoutData.rootPath);
                                if (workspacePath) {
                                    this.log('debug', `Found workspace path: ${workspacePath} from project layout: ${layoutData.rootPath}`);
                                    return workspacePath;
                                }
                            }
                        } catch (parseError) {
                            this.log('error', `Error parsing project layout: ${parseError}`);
                        }
                    }
                }
            }

            this.log('info', 'No workspace path found in any messageRequestContext');
            return undefined;
        } catch (error) {
            return undefined;
        }
    }

    private extractComposerIdFromKey(key: string): string | undefined {
        // Only extract from keys like "composerData:{composerId}"
        const match = key.match(/^composerData:([^:]+)/);
        return match ? match[1] : undefined;
    }

    private async getBubbleData(bubbleKey: string): Promise<any | undefined> {
        if (!this.db) {
            return undefined;
        }

        return new Promise((resolve) => {
            this.db!.get(
                'SELECT value FROM cursorDiskKV WHERE key = ?',
                [bubbleKey],
                (err, row: { value: string } | undefined) => {
                    if (err) {
                        this.log('error', `Error getting bubble data: ${err}`);
                        resolve(undefined);
                        return;
                    }
                    
                    if (row) {
                        try {
                            const data = JSON.parse(row.value);
                            resolve(data);
                        } catch (parseError) {
                            this.log('error', `Error parsing bubble data: ${parseError}`);
                            resolve(undefined);
                        }
                    } else {
                        resolve(undefined);
                    }
                }
            );
        });
    }

    private extractBubbleIdsFromComposerData(data: any): string[] {
        const bubbleIds: string[] = [];
        
        if (data.fullConversationHeadersOnly && Array.isArray(data.fullConversationHeadersOnly)) {
            for (const bubble of data.fullConversationHeadersOnly) {
                if (bubble.bubbleId) {
                    bubbleIds.push(bubble.bubbleId);
                }
            }
        }
        
        return bubbleIds;
    }

    private async getAllMessageRequestContexts(composerId: string, bubbleIds: string[]): Promise<any[]> {
        if (!this.db) {
            return [];
        }

        return new Promise((resolve) => {
            const contexts: any[] = [];
            let completedQueries = 0;
            const totalQueries = bubbleIds.length;

            if (totalQueries === 0) {
                resolve(contexts);
                return;
            }

            // Query messageRequestContext for each bubble ID
            for (const bubbleId of bubbleIds) {
                const key = `messageRequestContext:${composerId}:${bubbleId}`;
                this.db!.get(
                    'SELECT key, value FROM cursorDiskKV WHERE key = ?',
                    [key],
                    (err, row: { key: string; value: string } | undefined) => {
                        completedQueries++;
                        
                        if (err) {
                            this.log('error', `Error getting messageRequestContext for bubble ${bubbleId}: ${err}`);
                        } else if (row) {
                            try {
                                const data = JSON.parse(row.value);
                                contexts.push(data);
                            } catch (parseError) {
                                this.log('error', `Error parsing messageRequestContext data for bubble ${bubbleId}: ${parseError}`);
                            }
                        }

                        // Resolve when all queries are complete
                        if (completedQueries === totalQueries) {
                            this.log('debug', `Found ${contexts.length} messageRequestContext entries for ${totalQueries} bubbles`);
                            resolve(contexts);
                        }
                    }
                );
            }
        });
    }

    private getWorkspacePathFromName(workspaceName: string): string | undefined {
        try {
            // Load storage.json to get workspace path mapping
            const storagePath = this.getCursorStoragePath();
            const storageFile = path.join(storagePath, 'storage.json');
            
            if (!fs.existsSync(storageFile)) {
                this.log('info', `Storage file not found: ${storageFile}`);
                return undefined;
            }

            const storageContent = fs.readFileSync(storageFile, 'utf8');
            const storage = JSON.parse(storageContent);

            // Only check backupWorkspaces.folders
            if (storage.backupWorkspaces && storage.backupWorkspaces.folders) {
                for (const folder of storage.backupWorkspaces.folders) {
                    if (folder.folderUri) {
                        // Extract the path from folderUri
                        const uriMatch = folder.folderUri.match(/file:\/\/\/(.+)/);
                        if (uriMatch) {
                            const decodedPath = decodeURIComponent(uriMatch[1]);
                            const pathParts = decodedPath.split('/');
                            const nameFromPath = pathParts[pathParts.length - 1];
                            
                            // Check if the last part matches the workspace name
                            if (nameFromPath === workspaceName) {
                                this.log('debug', `Matched workspace name "${workspaceName}" with path "${decodedPath}"`);
                                return decodedPath;
                            }
                        }
                    }
                }
            }

            this.log('info', `No matching workspace found for name: ${workspaceName}`);
            return undefined;
        } catch (error) {
            this.log('error', `Error getting workspace path from name: ${error}`);
            return undefined;
        }
    }

    private mapMessageTypeToRole(type: number): 'user' | 'assistant' | 'system' | null {
        // Cursor message type mapping
        // Type 1 is typically user, Type 2 is typically assistant
        switch (type) {
            case 1:
                return 'user';
            case 2:
                return 'assistant';
            case 0:
                return 'system';
            default:
                return null;
        }
    }

    private filterMessageContent(content: string, role: string): { filteredContent?: string; metadata: any } {
        const metadata = {
            hasCodeBlocks: false,
            codeLanguage: undefined as string | undefined,
            messageLength: content.length,
            isFiltered: false
        };

        if (!this.config.ignoreCodeOutput || role !== 'assistant') {
            // Check for code blocks for metadata
            const codeBlockRegex = /```(\w+)?[\s\S]*?```/g;
            const matches = content.match(codeBlockRegex);
            if (matches && matches.length > 0) {
                metadata.hasCodeBlocks = true;
                const langMatch = matches[0].match(/```(\w+)/);
                if (langMatch) {
                    metadata.codeLanguage = langMatch[1];
                }
            }
            return { metadata };
        }

        // Filter assistant code blocks
        let filteredContent = content;
        metadata.isFiltered = true;

        // Remove code blocks
        filteredContent = content.replace(/```[\s\S]*?```/g, '[CODE_BLOCK_FILTERED]');
        
        // Remove inline code
        filteredContent = filteredContent.replace(/`[^`]+`/g, '[INLINE_CODE_FILTERED]');

        // Check for code blocks for metadata
        const codeBlockRegex = /```(\w+)?[\s\S]*?```/g;
        const matches = content.match(codeBlockRegex);
        if (matches && matches.length > 0) {
            metadata.hasCodeBlocks = true;
            const langMatch = matches[0].match(/```(\w+)/);
            if (langMatch) {
                metadata.codeLanguage = langMatch[1];
            }
        }

        return { filteredContent, metadata };
    }

    private createConversation(title: string, messages: ChatMessage[], data?: any, key?: string, workspacePath?: string): Conversation {
        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        
        const userMessages = messages.filter(msg => msg.role === 'user').length;
        const assistantMessages = messages.filter(msg => msg.role === 'assistant').length;
        const totalTokensEstimated = messages.reduce((sum, msg) => 
            sum + Math.ceil(msg.content.split(/\s+/).length * 1.3), 0
        );

        return {
            id: conversationId,
            createdAt: data?.createdAt ? new Date(data.createdAt) : now,
            updatedAt: data?.lastUpdatedAt ? new Date(data.lastUpdatedAt) : now,
            title,
            messages,
            metadata: {
                workspacePath: workspacePath || undefined,
                fileContext: [],
                totalMessages: messages.length,
                userMessages,
                assistantMessages,
                totalTokensEstimated,
                composerId: data?.composerId,
                sessionId: data?.sessionId,
                source: 'cursor-database',
                filePath: key
            }
        };
    }

    public dispose(): void {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    this.log('error', `Error closing database: ${err}`);
                }
            });
            this.db = null;
        }

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
    }

    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if (levels[level] >= levels[this.currentLogLevel]) {
            this.chatLogger.outputChannel.appendLine(`[${level.toUpperCase()}] ${message}`);
        }
    }

    public markComposerIdProcessed(composerId: string, bubbleIds: string[]) {
        if (!this.lastProcessedComposerIds.has(composerId)) {
            this.lastProcessedComposerIds.set(composerId, new Set());
        }
        const set = this.lastProcessedComposerIds.get(composerId)!;
        for (const bubbleId of bubbleIds) {
            set.add(bubbleId);
        }
    }
} 