import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Conversation, ChatMessage } from './chatLogger';

const execAsync = promisify(exec);

export interface GitConversationMessageOutput {
    content: string;
    role: string;
    timestamp: string;
    conversationId: string;
}

export class GitConversationTracker {
    private lastGitCommitTime: Date | null = null;
    private outputFilePath: string;
    private workspacePath: string;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
        this.outputFilePath = path.join(workspacePath, '.chatlogger', 'latest_conversation_since_git.json');
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
            const { stdout } = await execAsync('git log -1 --format=%cd --date=iso', {
                cwd: this.workspacePath
            });
            
            if (stdout.trim()) {
                this.lastGitCommitTime = new Date(stdout.trim());
                console.log(`Last git commit time: ${this.lastGitCommitTime}`);
            }
        } catch (error) {
            console.warn('Failed to get last git commit time:', error);
            // If git command fails, use a default time (24 hours ago)
            this.lastGitCommitTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
        }
    }

    public async outputLatestConversationToFile(conversations: Conversation[]): Promise<void> {
        try {
            // Ensure the .chatlogger directory exists
            const chatloggerDir = path.dirname(this.outputFilePath);
            await fs.ensureDir(chatloggerDir);

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
            await fs.writeJson(this.outputFilePath, newMessages, { spaces: 2 });
            console.log(`All new messages since git commit saved to: ${this.outputFilePath}`);
        } catch (error) {
            console.error('Error outputting conversation to file:', error);
            throw error;
        }
    }

    public async triggerCalculation(conversations: Conversation[]): Promise<void> {
        console.log('Triggering git-based conversation calculation...');
        await this.outputLatestConversationToFile(conversations);
    }

    public getOutputFilePath(): string {
        return this.outputFilePath;
    }

    public getLastGitCommitTime(): Date | null {
        return this.lastGitCommitTime;
    }
} 