import CodeColection from '../../Database/Models/CodeCollection'
import ConsensusLocalController from './ConsensusLocalController'
import ConsensusEventBasedController from './ConsensusEventBasedController'
import ConsensusCodeSearchController from './ConsensusCodeSearchController'
import EventWebSocket from '../../Communication/EventBased/EventWebSocket'
import Votation from '../Votation'
import SocketVotationSolver from '../VotationSolvers/SocketVotationSolver';

import API from '../../Communication/API/API'
import Code from '../../Database/Models/Code/Code';

//Hybrid controller that alternates local and EventBased on network errors.
export default class ConsensusRobustController {
    constructor( lastScanHandler ) {
        this.lastScanHandler = lastScanHandler;
        this.codeAddedListener = null;
        this.connectionStatusListener = null;

        this.collections = [];
        this.socketControllers = [];
        this.localControllers = [];
        this.notFoundController = null;

        this.scannedOffline = [];

        this.codeCount = 0;
        this.validated = 0;

        this.isOnline = false;
        this.votationEnded = this.votationEnded.bind( this );
    }

    async initialize( session, types ) { 
        let totalCodes = 0;
        let totalValidated = 0;

        for( let i = 0; i < types.length; i++ ) {
            const type = types[ i ]
            const collection = new CodeColection( session, type, ( newCode ) => { 
                this.codeCount++; 
                if( this.codeAddedListener ) {
                    this.codeAddedListener( this.codeCount );
                }
            });
            await collection.syncCollection();
            totalCodes += await collection.getCodeCount();
            totalValidated += collection.validated;

            this.collections.push(
                collection    
            );
            
            const socketController = new ConsensusEventBasedController(
                new EventWebSocket( 
                    API.connection, 
                    session.id + '-' + session.name.replace( ' ', '_' ) + '-' + type.id + '-' + type.type.replace( ' ', '_' ),
                    () => this.socketConnected(),
                    () => this.socketDisconnected(),
                    true
                ),
                collection,
                this.votationEnded.bind( this )
            );
            socketController.startTask();
            this.socketControllers.push(
                socketController    
            );

            const localController = new ConsensusLocalController( 
                collection, 
                this.votationEnded.bind( this )
            );
            localController.startTask();
            this.localControllers.push(
                localController
            );
        };

        this.notFoundController = new ConsensusCodeSearchController(
            new EventWebSocket(
                API.connection,
                session.id + '-' + session.name.replace( ' ', '_' ) +'-UNKNOWN',
                () => this.socketConnected(),
                () => this.socketDisconnected(),
                true
            ),
            this.collections,
            this.votationEnded.bind( this )
        );
        this.notFoundController.startTask();

        this.codeCount = totalCodes;
        this.validated = totalValidated;
    }

    stop() {
        this.socketControllers.forEach( controller => {
            controller.stopTask();
            controller.eventHandler.disconnect();
        });

        this.notFoundController.stopTask();
        this.notFoundController.eventHandler.disconnect();

        this.localControllers.forEach( controller => {
            controller.stopTask();
        });
    }

    getCollections() {
        const collections = [];
        this.localControllers.forEach( controller => {
            collections.push( controller.codeCollection );
        });

        return collections;
    }

    async codeScanned( code, mode ) {
        //console.log( 'to vote: ' + code )
        if( this.isOnline ) {
            await this.openSocketVotation( code, mode );
        } else { 
            await this.openLocalVotation( code, mode );
        }
    }

    async openSocketVotation( code, mode, isOffline = false ) {
        let notFoundIn = 0;
        for(let i = 0; i < this.socketControllers.length; i++) {
            const controller = this.socketControllers[ i ];
            if( await controller.codeCollection.codeExists( code ) ) {
                console.log( 'vote in: ' + controller.eventHandler.channel );
                controller.codeScanned( code, mode, isOffline );
                break;
            } else {
                notFoundIn++;
            }
        }

        if( notFoundIn === this.socketControllers.length ) {
            console.log( 'code not found' );
            this.notFoundController.codeScanned( code, mode, isOffline, true );
        }
    }

    async openLocalVotation( code, mode ) {
        let notFoundIn = 0;
        for(let i = 0; i < this.localControllers.length; i++) {
            const controller = this.localControllers[ i ];
            if( await controller.codeCollection.codeExists( code ) ){                    
                controller.codeScanned( code, mode );
                break;
            } else {
                notFoundIn++;
            }
        }

        if( notFoundIn === this.localControllers.length ) {
            console.log( 'code not found' );
            this.localControllers[ 0 ].codeScanned( code, mode );
        }

        this.scannedOffline.push( {code, mode} );
    }

    async openVotationForOfflineScanned() {
        while( this.scannedOffline.length > 0 ) {
            const toVote = this.scannedOffline.shift();
            this.openSocketVotation( toVote.code, toVote.mode, true );
        }
    }

    socketConnected() {
        console.log( 'connection okey' );
        this.isOnline = true;
        if( this.connectionStatusListener ) {
            this.connectionStatusListener( true );
        }

        this.openVotationForOfflineScanned();
    }

    socketDisconnected() {
        console.log( 'lost connection' );
        this.isOnline = false; 
        if( this.connectionStatusListener ) {
            this.connectionStatusListener( false );
        }
    }

    wasOpenedByMe( votation ) {
        if( votation.codeSearch && this.notFoundController.eventHandler.nodeId === votation.openedBy ) {
            return true;
        }
        for( let i = 0; i < this.socketControllers.length; i++ ) {
            if( votation.openedBy === this.socketControllers[i].eventHandler.nodeId ) {
                return true;
            }
        }

        return false;
    }
    
    votationEnded( votation, type ) {
        console.log( votation );
        const transportTime = Math.abs( new Date().getTime() - new Date( votation.closed_at ).getTime() );
        console.log( 'votation end' );
        //console.log( votation );
        console.log( 'elapsed: ' + votation.elapsed );
        console.log( 'time to receive: ' + transportTime );        

        if( this.isOnline ) {
            if( this.wasOpenedByMe( votation ) && !votation.offline ) {
                if( votation.codeSearch == true ) {
                    //Code found, checks if the collection is allowed
                    if( votation.verification === "valid" ) {
                        for( let i = 0; i < this.socketControllers.length; i++ ) {
                            const controller = this.socketControllers[ i ];
                            const collection = controller.codeCollection;
                            //Collection allowed
                            if( collection.type.id+'-'+collection.type.type ===  votation.inCollection ) {
                                //Open a votation
                                controller.openVotation( new Votation(
                                    data.votation.openedBy, 
                                    API.me.id,
                                    votation.codeFound.code, 
                                    votation.scanMode, 
                                    new Date(),
                                    false, 
                                    false,
                                    new SocketVotationSolver(controller.eventHandler) 
                                ));
                                return;
                            }
                        }
                        //Not allowed
                        this.notifyVotationResult({
                            ...votation, 
                            consensus: {code: votation.codeFound.code }
                        }, votation.inCollection.split('-')[1] );
                        return;
                    }
                }
                this.notifyVotationResult( votation, type );
            }
        } else {
            this.notifyVotationResult( votation, type );
        }
    }

    notifyVotationResult( votation, type ) {
        if( votation.consensus.id === undefined ) {
            if( votation.codeSearch ) {
                this.lastScanHandler({
                    verification: votation.verification,
                    code: votation.consensus.code,
                    name: '',
                    type: '',
                    message: 'El código no existe.'
                });
            } else {
                this.lastScanHandler({
                    verification: votation.verification,
                    code: votation.consensus.code,
                    name: '',
                    type: '',
                    message: votation.codeSearch ? 
                            'El código no existe.' : 
                            'Este escáner no está autorizado a leer: ' + type
                });
            }
        } else {
            if( votation.consensus.validations === 1 && votation.verification !== 'not_valid' ) {
                this.validated++;
            }

            this.lastScanHandler({
                verification: votation.verification,
                code: votation.consensus.code,
                name: votation.consensus.name,
                type: type,
                message: votation.message
            });
        }
    }
}