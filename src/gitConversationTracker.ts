import * as vscode from 'vscode';
import { Conversation } from './chatLogger';

export interface GitConversationMessageOutput {
    content: string;
    role: string;
    timestamp: string;
    conversationId: string;
}

export class GitConversationTracker {
    private lastGitCommitTime: Date | null = null;
    private outputFileUri: vscode.Uri;
    private workspaceFolder: vscode.WorkspaceFolder;

    constructor(workspaceFolder: vscode.WorkspaceFolder) {
        this.workspaceFolder = workspaceFolder;
        this.outputFileUri = vscode.Uri.joinPath(workspaceFolder.uri, '.chatlogger', 'latest_conversation_since_git.json');
        this.initializeGitCommitTime();
    }

    private async initializeGitCommitTime(): Promise<void> {
        try {
            await this.updateLastGitCommitTime();
        } catch (error) {
            console.warn('Failed to initialize git commit time:', error);
        }
    }

    private async updateLastGitCommitTime(): Promise<void> {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            const api = gitExtension?.getAPI(1);
            const repo = api?.repositories[0];
            if (!repo) {
                this.lastGitCommitTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // fallback
                return;
            }
            const logEntries = await repo.log({ maxEntries: 1 });
            if (logEntries && logEntries.length > 0) {
                this.lastGitCommitTime = logEntries[0].authorDate;
            } else {
                this.lastGitCommitTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // fallback
            }
        } catch (error) {
            console.warn('Failed to get last git commit time:', error);
            this.lastGitCommitTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
        }
    }

    public async outputLatestConversationToFile(conversations: Conversation[]): Promise<void> {
        try {
            // Ensure the .chatlogger directory exists
            const chatloggerDir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.chatlogger');
            try {
                await vscode.workspace.fs.createDirectory(chatloggerDir);
            } catch (e) {
                // Ignore if already exists
            }

            // Update the last git commit time
            await this.updateLastGitCommitTime();
            if (!this.lastGitCommitTime) {
                throw new Error('No git commit time available');
            }

            // Collect all messages newer than the last git commit
            const newMessages: GitConversationMessageOutput[] = [];
            for (const conversation of conversations) {
                for (const message of conversation.messages) {
                    const msgTime = new Date(message.timestamp);
                    if (msgTime > this.lastGitCommitTime) {
                        newMessages.push({
                            content: message.content,
                            role: message.role,
                            timestamp: msgTime.toLocaleString(),
                            conversationId: conversation.id
                        });
                    }
                }
            }

            // Write to file (flat array)
            await vscode.workspace.fs.writeFile(
                this.outputFileUri,
                Buffer.from(JSON.stringify(newMessages, null, 2), 'utf8')
            );
            console.log(`All new messages since git commit saved to: ${this.outputFileUri.fsPath}`);
        } catch (error) {
            console.error('Error outputting conversation to file:', error);
            throw error;
        }
    }

    public async triggerCalculation(conversations: Conversation[]): Promise<void> {
        console.log('Triggering git-based conversation calculation...');
        await this.outputLatestConversationToFile(conversations);
    }

    public getOutputFileUri(): vscode.Uri {
        return this.outputFileUri;
    }

    public getLastGitCommitTime(): Date | null {
        return this.lastGitCommitTime;
    }
} 