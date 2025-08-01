import { NodeStatus, OutputNodeData, useNodeContext } from '@/contexts/node-context';
import { Agent } from '@/data/agents';
import { LanguageModel } from '@/data/models';
import { extractBaseAgentKey } from '@/data/node-mappings';
import { flowConnectionManager } from '@/hooks/use-flow-connection';
import {
  HedgeFundRequest
} from '@/services/types';

// const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const API_BASE_URL = import.meta.env.VITE_API_URL;

export const api = {
  /**
   * Gets the list of available agents from the backend
   * @returns Promise that resolves to the list of agents
   */
  getAgents: async (): Promise<Agent[]> => {
    try {
      const response = await fetch(`${API_BASE_URL}/hedge-fund/agents`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.agents;
    } catch (error) {
      console.error('Failed to fetch agents:', error);
      throw error;
    }
  },

  /**
   * Gets the list of available models from the backend
   * @returns Promise that resolves to the list of models
   */
  getLanguageModels: async (): Promise<LanguageModel[]> => {
    try {
      const response = await fetch(`${API_BASE_URL}/language-models/`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.models;
    } catch (error) {
      console.error('Failed to fetch models:', error);
      throw error;
    }
  },

  /**
   * Saves JSON data to a file in the project's /outputs directory
   * @param filename The name of the file to save
   * @param data The JSON data to save
   * @returns Promise that resolves when the file is saved
   */
  saveJsonFile: async (filename: string, data: any): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE_URL}/storage/save-json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename,
          data
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log(result.message);
    } catch (error) {
      console.error('Failed to save JSON file:', error);
      throw error;
    }
  },

  /**
   * Runs a hedge fund simulation with the given parameters and streams the results
   * @param params The hedge fund request parameters
   * @param nodeContext Node context for updating node states
   * @param flowId The ID of the current flow
   * @returns A function to abort the SSE connection
   */
  runHedgeFund: (
    params: HedgeFundRequest, 
    nodeContext: ReturnType<typeof useNodeContext>,
    flowId: string | null = null
  ): (() => void) => {
    // Convert tickers string to array if needed
    if (typeof params.tickers === 'string') {
      params.tickers = (params.tickers as unknown as string).split(',').map(t => t.trim());
    }

    // Helper function to get agent IDs from graph structure
    const getAgentIds = () => params.graph_nodes.map(node => node.id);

    // Pass the unique node IDs directly to the backend
    const backendParams = params;

    // For SSE connections with FastAPI, we need to use POST
    // First, create the controller
    const controller = new AbortController();
    const { signal } = controller;

    // Make a POST request with the JSON body
    fetch(`${API_BASE_URL}/hedge-fund/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(backendParams),
      signal,
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
            
      // Process the response as a stream of SSE events
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      // Function to process the stream
      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              break;
            }
            
            // Decode the chunk and add to buffer
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            
            // Process any complete events in the buffer (separated by double newlines)
            const events = buffer.split('\n\n');
            buffer = events.pop() || ''; // Keep last partial event in buffer
            
            for (const eventText of events) {
              if (!eventText.trim()) continue;
                            
              try {
                // Parse the event type and data from the SSE format
                const eventTypeMatch = eventText.match(/^event: (.+)$/m);
                const dataMatch = eventText.match(/^data: (.+)$/m);
                
                if (eventTypeMatch && dataMatch) {
                  const eventType = eventTypeMatch[1];
                  const eventData = JSON.parse(dataMatch[1]);
                  
                  console.log(`Parsed ${eventType} event:`, eventData);
                  
                  // Process based on event type
                  switch (eventType) {
                    case 'start':
                      // Reset all nodes at the start of a new run
                      nodeContext.resetAllNodes(flowId);
                      break;
                    case 'progress':
                      if (eventData.agent) {
                        // Map the progress to a node status
                        let nodeStatus: NodeStatus = 'IN_PROGRESS';
                        if (eventData.status === 'Done') {
                          nodeStatus = 'COMPLETE';
                        }
                        // Map the backend agent name to the unique node ID
                        const baseAgentKey = eventData.agent.replace('_agent', '');
                        
                        // Find the unique node ID that corresponds to this base agent key
                        const uniqueNodeId = getAgentIds().find(id => 
                          extractBaseAgentKey(id) === baseAgentKey
                        ) || baseAgentKey;
                                                
                        // Use the enhanced API to update both status and additional data
                        nodeContext.updateAgentNode(flowId, uniqueNodeId, {
                          status: nodeStatus,
                          ticker: eventData.ticker,
                          message: eventData.status,
                          analysis: eventData.analysis,
                          timestamp: eventData.timestamp
                        });
                      }
                      break;
                    case 'complete':
                      // Store the complete event data in the node context
                      if (eventData.data) {
                        nodeContext.setOutputNodeData(flowId, eventData.data as OutputNodeData);
                      }
                      // Mark all agents as complete when the whole process is done
                      nodeContext.updateAgentNodes(flowId, getAgentIds(), 'COMPLETE');
                      // Also update the output node
                      nodeContext.updateAgentNode(flowId, 'output', {
                        status: 'COMPLETE',
                        message: 'Analysis complete'
                      });

                      // Update flow connection state to completed
                      if (flowId) {
                        flowConnectionManager.setConnection(flowId, {
                          state: 'completed',
                          abortController: null,
                        });

                        // Optional: Auto-cleanup completed connections after a delay
                        setTimeout(() => {
                          const currentConnection = flowConnectionManager.getConnection(flowId);
                          if (currentConnection.state === 'completed') {
                            flowConnectionManager.setConnection(flowId, {
                              state: 'idle',
                            });
                          }
                        }, 30000); // 30 seconds
                      }
                      break;
                    case 'error':
                      // Mark all agents as error when there's an error  
                      nodeContext.updateAgentNodes(flowId, getAgentIds(), 'ERROR');
                      
                      // Update flow connection state to error
                      if (flowId) {
                        flowConnectionManager.setConnection(flowId, {
                          state: 'error',
                          error: eventData.message || 'Unknown error occurred',
                          abortController: null,
                        });
                      }
                      break;
                    default:
                      console.warn('Unknown event type:', eventType);
                  }
                }
              } catch (err) {
                console.error('Error parsing SSE event:', err, 'Raw event:', eventText);
              }
            }
          }
          
          // After the stream has finished, check if we are still in a connected state.
          // This can happen if the backend closes the connection without sending a 'complete' event.
          if (flowId) {
            const currentConnection = flowConnectionManager.getConnection(flowId);
            if (currentConnection.state === 'connected') {
              flowConnectionManager.setConnection(flowId, {
                state: 'completed',
                abortController: null,
              });
            }
          }
        } catch (error: any) { // Type assertion for error
          if (error.name !== 'AbortError') {
            console.error('Error reading SSE stream:', error);
            // Mark all agents as error when there's a connection error
            nodeContext.updateAgentNodes(flowId, getAgentIds(), 'ERROR');
            
            // Update flow connection state to error
            if (flowId) {
              flowConnectionManager.setConnection(flowId, {
                state: 'error',
                error: error.message || 'Connection error',
                abortController: null,
              });
            }
          }
        }
      };
      
      // Start processing the stream
      processStream();
    })
    .catch((error: any) => { // Type assertion for error
      if (error.name !== 'AbortError') {
        console.error('SSE connection error:', error);
        // Mark all agents as error when there's a connection error
        nodeContext.updateAgentNodes(flowId, getAgentIds(), 'ERROR');
        
        // Update flow connection state to error
        if (flowId) {
          flowConnectionManager.setConnection(flowId, {
            state: 'error',
            error: error.message || 'Connection failed',
            abortController: null,
          });
        }
      }
    });

    // Return abort function
    return () => {
      controller.abort();
      // Update connection state when manually aborted
      if (flowId) {
        flowConnectionManager.setConnection(flowId, {
          state: 'idle',
          abortController: null,
        });
      }
    };
  },
}; 
