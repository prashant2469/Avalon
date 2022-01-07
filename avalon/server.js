
var express = require('express');
var url = require('url');
var app = express();
var path = require("path");
var server = require('http').Server(app);
var io = require('socket.io')(server);

// if set to true, will make 'user' always first in turnOrder, 
// and vote 2-2 automatically for accept/rejecting missions with only
// 'user' casting the tie-breaking vote.
var DEBUG = false;
var DEBUG_TO_ADD = 4;

var MIN_PLAYERS = 5;
var MAX_PLAYERS = 12;

var MISSIONS_TO_WIN = 3;
if (DEBUG) {
    MISSIONS_TO_WIN = 1;
}


var can_play = DEBUG;

var PASSWORD_ACTIVATE = 'niholez';
var PASSWORD_DEACTIVATE = 'kill';
var PASSWORD_CLEAN = 'clean';
var PASSWORD_CLEAN_AND_KILL = PASSWORD_CLEAN + PASSWORD_DEACTIVATE;

var port = process.env.PORT || 5000;
if(DEBUG) {
    port = 2000;
}
console.log('Listening on port: ' + port);
server.listen(port);


//allow ppl to access site
var PASS = 'nolava';
var RESET = 'reset_game';


app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));


var gameLobbies = {};
var games = {};


var numPlayersToPartySizes = {
    5: [2, 3, 2, 3, 3], 
    6: [2, 3, 4, 3, 4], 
    7: [2, 3, 3, 4, 4], 
    8: [3, 4, 4, 5, 5], 
    9: [3, 4, 4, 5, 5], 
    10: [3, 4, 4, 5, 5], 
    11: [3, 4, 5, 5, 6], 
    12: [3, 4, 5, 6, 6], 
}

if (DEBUG) {
     numPlayersToPartySizes = {
        5: [1,1,1,1,1], 
        6: [1,1,1,1,1], 
        7: [1,1,1,1,1], 
        8: [1,1,1,1,1], 
        9: [1,1,1,1,1], 
        10: [1,1,1,1,1], 
        11: [1,1,1,1,1], 
        12: [1,1,1,1,1]
    }
}

function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

function getMissionData(game) {
     var missionData = [];
     for(var i = 0; i < game.round - 1; i++) {
        var round = game.rounds[i];
        var lastProposal = round.proposals[round.proposals.length - 1];

        var playersChosen = lastProposal.playersSelected;
        var numSuccesses = round.numSuccesses;
        var numFails = round.numFails;
        var playerVoteMap = lastProposal.playerVoteMap;
        var selector = lastProposal.selector;
        var obj = {
            selector: selector,
            playersChosen: playersChosen, 
            numSuccesses: numSuccesses, 
            numFails: numFails, 
            playerVoteMap: playerVoteMap
        };
        missionData.push(obj);
    }
    return missionData;
}

//begin classes 

//represents the pre-game lobby as people come in.
function GameLobby(gameCode, creator){
	this.gameCode = gameCode;
	this.usernames = [creator];
}

//represents a Player in the game. 
function Player(name, team, role){
   this.name = name;
   this.team = team;
   this.role = role;
   //if the player has used the lady of the lake before so they don't use it again
   this.usedLadyOfLake = false;
}

//represents a Round of the game. 
function Round(roundNumber, numPlayers) {
    this.roundNumber = roundNumber;
    this.proposals = [];
    this.numPlayers = numPlayers;
    //how many people should be on this round.
    this.partySize = numPlayersToPartySizes[numPlayers][roundNumber - 1];


    this.addProposal = function(proposal) {
        this.proposals.push(proposal)
    }

    //called once after mission results come in. 
    //computes and stores whether the mission passed.
    this.setMissionResults = function(missionResults) {
        this.missionResults = missionResults;
        
        var numFails = 0;
        var numSuccesses = 0;
        for(var personOnMission in missionResults) {
            if(missionResults[personOnMission] == "Fail") {
                numFails++;
            } else {
                numSuccesses++;
            }
        }

        this.numFails = numFails;
        this.numSuccesses = numSuccesses;

        // Code that works
        // var missionPassed;
        // if (numFails == 0) {
        //     missionPassed = true;
        // } else {
        //     if (this.roundNumber == 4 && this.numPlayers >= 7)
        //         missionPassed = (numFails == 1);
        //     } else {
        //         missionPassed = false;
        //     }
        // }

        // Missions on round 4 of games with >= 7 players can need 2 fails to fail
        
        this.missionPassed = (numFails == 0) ? (true) : (this.roundNumber == 4 && this.numPlayers >= 7 && numFails == 1);

    }

    //retrieves whether the mission passed. setMissionResults must be called first.
    this.missionPassed = function() {
        return this.missionPassed;
    }

    this.isMissionBusted = function() {
        return this.streakOfMissionRejects > 4;
    }
}

//approve or reject. pass or fail.

//represents a Proposal for putting people on a mission.
function Proposal(selector, playersSelected) {
    this.playersSelected = playersSelected;
    this.selector = selector;

    this.addVotingResults = function(isMissionSuccess, playerVoteMap) {
        this.playerVoteMap = playerVoteMap;
        this.isMissionSuccess = isMissionSuccess;
    }
}

//represents a running game
function GameInstance(gameLobby, specialsGood, specialsBad, usingLadyOfLake) {
    console.log('trying to create a game instance for: ' + gameLobby.gameCode);
    players = [];
    this.rounds = [];
    this.numConfirmed = 0;
    this.numMissionConfirmed = 0;
    this.rejectCount = 0;
    this.usingLadyOfLake = usingLadyOfLake;
    var numPlayers = gameLobby.usernames.length;
    this.numPlayers = numPlayers;

    this.numSuccessfulMissions = 0;
    this.numFailedMissions = 0;
    shuffleArray(gameLobby.usernames) //shuffle the array of players
    
    // choosing turn order
    this.turnOrder = gameLobby.usernames.slice();
    shuffleArray(this.turnOrder);
    //todo: delete proposals
    // this.proposals = [];
    // for (var i = 0; i < 5; i++) {
    //     this.proposals.push([null, null, null, null, null]);
    // } 
    // proposals[i][j] = for round i, on proposal j, an array of length 2
    // proposals[i][j][k] where k=0,1,2. 
    // if k=0, returns the username of player who chose. if k=1, returns the array of chosen players.
    // if k=2, returns a map of {username: "accept/reject"}
    // round is 1-indexed, so subtract 1. proposal is "rejectCount" which is 0 indexed.

    
    if (DEBUG) {
        while (this.turnOrder[0] != 'user') {
            shuffleArray(this.turnOrder);
        }
    }

    //logic for separating any number of players into vanilla good/bad 


    //first choose a certain number of bads based on parity
    var numBad = Math.ceil(numPlayers/2) - 1;

    // special case
    if (numPlayers == 9) {
        numBad = 3;
    } if (numPlayers == 11) {
        numBad = 4;
    }

    this.goodChars = specialsGood.slice();
    this.badChars = specialsBad.slice();

    var numGood = numPlayers - numBad;
    specialsGood.forEach(function(specialGood) {
        console.log('adding ' + specialGood);
        var p1 = new Player(gameLobby.usernames.pop(), "good", specialGood);
        players.push(p1);
    });

    specialsBad.forEach(function(specialBad) {
        console.log('adding ' + specialBad);
        var p1 = new Player(gameLobby.usernames.pop(), "bad", specialBad);
        players.push(p1);
    });

    for(var i = 0; i < numBad - specialsBad.length; i++) {
        console.log('adding a minion');
        var badGuy = new Player(gameLobby.usernames.pop(), "bad", "minion");
        players.push(badGuy);
        this.badChars.push('minion');
    }
    for(var i = 0; i < numGood - specialsGood.length; i++) {
        console.log('adding a servant');
        var badGuy = new Player(gameLobby.usernames.pop(), "good", "servant");
        players.push(badGuy);
        this.goodChars.push('servant');
    }

    //looks up player based on the username and returns the role and team
    this.getPlayerObj = function(username) {
        //console.log(this.players)
        var matchedPlayers = this.players.filter(function(player) {
            if(player.name == username) {
                return true;
            }
        });
        if(matchedPlayers.length == 1) {
            return matchedPlayers[0];
        } else {
           if(matchedPlayers.length == 0) {
                throw 'player does not exist with username ' + username;
           } else {
                throw 'duplicate players exist with username ' + username;
           }
        }
    }

    //returns the bad players. 
    this.getBadPlayers = function() {
        var result = []
        for(var i = 0; i < this.players.length; i++) {
            var player = this.players[i];
            if(player.team === "bad") {
                result.push(player.name)
            }
        }
        return result;
    }

    //returns the player who is merlin
    this.getMerlin = function() {
        for(var i = 0; i < this.players.length; i++) {
            var player = this.players[i];
            if(player.role === "merlin") {
                return player.name;
            }
        }
    }

    this.addNewRound = function(round) {
        this.rounds.push(round);
    }

    //console.log('done initializing the game. players: ' + JSON.stringify(players))
    this.players = players;

    this.round = 1; //init the round.

    this.addNewRound(new Round(1, this.numPlayers));

    this.currentKing = 0; // turnOrder
    //todo: replace game board with calculated version of game board using the list of rounds.
    //represents the game board. If we have 5 people it will INITIALLY be [2, 3, 2, 3, 3]
    //if the first round failed, then it will be [F, 3, 2, 3, 3]
    //the the second round succeeded, then it will [F, S, 2, 3, 3]
    this.gameProgress = numPlayersToPartySizes[players.length].slice();
    if(this.usingLadyOfLake) {
        var ladyHolder;
        if(DEBUG) {
            ladyHolder = this.getPlayerObj("user");
        } else {
            ladyHolder = this.players[Math.floor(Math.random()*this.players.length)];
        }
        console.log(ladyHolder.name + ' was initialized as the ' + ladyHolder);
        ladyHolder.usedLadyOfLake = true;
        this.ladyHolder = ladyHolder;
    }

}

//returns all the elements in arr1 that are NOT in arr2
function arrayDiff(arr1, arr2) {
    return arr1.filter(function(element) {
        return arr2.indexOf(element) == -1;
    });
}

function sendGameOverEvent(payload) {
    io.emit('game over', payload);
}

//end classes

//socket events
io.on('connection', function(socket) {
    console.log('received connection!')
    socket.on('startGameButtonPressed', function(data) {
        if(!can_play) {
            io.emit('game started', {gameCode: data.gameCode, error: !can_play})
            return;
        }
        //data contains the person who pressed the button. 
        console.log('start button is pressed')
        var game = gameLobbies[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }
        if (!(game.usernames.length >= MIN_PLAYERS && game.usernames.length <= MAX_PLAYERS)) {
            // TODO: enforce length. alert doesn't work unless in correct file.
            //alert("avalon requires between 5 and 10 players to play.");
            return;
        }
        var specialsGood = data.specialsGood;
        var specialsBad = data.specialsBad;
        var usingLadyOfLake = data.usingLadyOfLake;

        games[data.gameCode] = new GameInstance(game, specialsGood, specialsBad, usingLadyOfLake);
        io.emit('game started', {gameCode: data.gameCode, extraInfo: data.extraInfo, error: !can_play})

    });

    socket.on('merlin chosen', function(data) {
        var game = games[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }
        var merlin = game.getMerlin();
        if(data.merlinChoice != merlin) {
            console.log('bad guys unsucessfully picked merlin as "' + data.merlinChoice + '"');
            sendGameOverEvent({gameCode: data.gameCode, winner: 'good', reason: 'Bad guys failed to pick Merlin. The real merlin was: ' + merlin})
        } else {
            console.log('bad guys successfully picked merlin ');
            sendGameOverEvent({gameCode: data.gameCode, winner: 'bad', reason: 'Bad guys successfully picked merlin ' + merlin})
        }
    });

    socket.on('confirmTeamButtonPressed', function(data) {
        //data contains the person who pressed the button. 
        console.log('confirm button is pressed')
        var game = games[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }
        console.log("team confirmed");
        console.log(data.chosen);
        var username = data.clicker;
        var round = game.round;
        var rejectCount = game.rejectCount;

        
        var proposal = new Proposal(username, data.chosen);
        game.currentProposal = proposal;


        //games[data.gameCode] = new GameInstance(game);
        ///console.log("confirm on round " + (round-1) + ", rejectCount at " + rejectCount);
        
        //game.proposals[round-1][rejectCount] = [username, chosen, {}];
        io.emit('team confirmed', {gameCode: data.gameCode, chosen: data.chosen, chooser: username, proposal: proposal})
    });

    socket.on('confirmVoteButtonPressed', function(data) {
        //data contains the person who pressed the button. 
        console.log('confirm vote button is pressed')
        var game = games[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }

        var rejectCount = game.rejectCount;
        var username = data.clicker;
        if(!game.votes) {
            game.votes = {};
        }
        game.numConfirmed++;
        //game.proposals[round-1][rejectCount][2][username] = data.vote; 

        game.votes[username] = data.vote;

        console.log('current num players voted: ' + game.numConfirmed + ' need a total of ' + game.numPlayers + ' votes: ' + JSON.stringify(game.votes));


        // TODO: REMOVE

        if (DEBUG) {
            if (game.numConfirmed == 1) {
                var temp = ['user1', 'user2', 'user3', 'user4'];
                for (var i = 0 ; i < temp.length; i++) {
                    game.votes[temp[i]] = i % 2 == 0 ? 'Approve' : 'Reject';
                    game.numConfirmed++;
                }
            }
        }

        if (game.numConfirmed == game.numPlayers) {

            console.log('all players have voted! Here is the voting pattern: ' + game.votes.toString());
            var approveCount = 0;
            var playerVoteMap = game.votes;
            Object.keys(playerVoteMap).forEach(function(key) {
                if(playerVoteMap[key] == 'Approve') {
                    approveCount++;
                }
            });
            console.log('number of approves: ' + approveCount + ' number of players: ' + game.numPlayers);
            var wentThrough  = false;
            if(approveCount/game.numPlayers > 0.5) {
                wentThrough = true;
            }
            //add the voting results
            game.currentProposal.addVotingResults(wentThrough, playerVoteMap);

            //get the current round
            var currentRound = game.rounds[game.round - 1];
            currentRound.addProposal(game.currentProposal);

            //5 missions rejected in a row.
            if(currentRound.isMissionBusted()) {
                //game over!!
                game.over = true;
            }

            if(wentThrough) {
                io.emit('team approved', {gameCode: data.gameCode, players: game.players, chosen: game.currentProposal.playersSelected, playerVoteMap: playerVoteMap});
                game.rejectCount = 0;
                game.missionVotePhase = true;
            } else {
                game.currentKing = (game.currentKing + 1) % game.numPlayers;
                game.rejectCount++;
                if(game.rejectCount == 5) {
                    sendGameOverEvent({gameCode: data.gameCode,'winner': 'bad', 'reason': '5 mission rejects'});
                } else {
                    io.emit('team rejected', {
                        playerVoteMap: playerVoteMap,
                        game: game,
                        chosen: game.currentProposal.playersSelected,
                        gameCode: data.gameCode, 
                        currentUser: game.turnOrder[game.currentKing], 
                        rejectCount: game.rejectCount
                    });
                }
            }

            //reset all the cached variables
            game.numConfirmed = 0;
            game.votes = undefined;
            game.oldProposal = game.currentProposal;
            game.currentProposal = undefined;
        } else {
            var playerNames = game.players.map(function(player) {
                return player.name;
            });

            var playersVotedSoFar = Object.keys(game.votes);
            //return the list of players who have not voted yet to the front end...
            var playersNotVotedSoFar = arrayDiff(playerNames, playersVotedSoFar);
            io.emit('new player voted', {notVoted: playersNotVotedSoFar, gameCode: data.gameCode})
        }
        //games[data.gameCode] = new GameInstance(game);
        
    });


    socket.on('confirmMissionVoteButtonPressed', function(data) {
        //data contains the person who pressed the button. 
        console.log('confirm mission vote button is pressed')
        var game = games[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }

        var votesNeeded = game.rounds[game.round - 1].partySize;
        if(!game.missionVotes) {
            game.missionVotes = {};
        }
        var username = data.clicker;
        
        //game.proposals[round-1][rejectCount][2][username] = data.vote; 
        console.log('current num players voted: ' + game.numMissionConfirmed + ' need a total of ' + votesNeeded)
        game.missionVotes[username] = data.vote;
        game.numMissionConfirmed++;


        if (game.numMissionConfirmed == votesNeeded) {

            //get the current round
            var currentRound = game.rounds[game.round - 1];
            currentRound.setMissionResults(game.missionVotes);

            // the results
            if (currentRound.missionPassed) {
                console.log("mission passed!");
                game.numSuccessfulMissions++;
            } else {
                console.log("mission failed...");
                game.numFailedMissions++;
            }

            game.gameProgress[game.round - 1] = currentRound.missionPassed ? 'S' : 'F';
            game.round++;
            game.currentKing = (game.currentKing + 1) % game.numPlayers;

            var missionData = getMissionData(game);

            if (game.numSuccessfulMissions == MISSIONS_TO_WIN || game.numFailedMissions == MISSIONS_TO_WIN) {
                game.over = true;
                if (game.numSuccessfulMissions == MISSIONS_TO_WIN) {
                    console.log("good guys win!");
                    var assassin = game.getBadPlayers()[0];
                    for(var i = 0; i < game.players.length; i++) {
                        if(game.players[i].role == 'assassin') {
                            assassin = game.players[i].name;
                            console.log('found assassin to be: ' + game.players[i].name);
                        }
                    }
                    //TODO: change the assassin once role is supported.

                    var goodPlayers = game.players.filter(function(player) {
                        return player.team === 'good';
                    });
                    io.emit('choose merlin', {
                        gameCode: data.gameCode, 
                        assassin: assassin, 
                        gameProgress: game.gameProgress,
                        missionData: missionData, 
                        goodPlayers: goodPlayers
                    });
                    return;
                } else {
                    console.log("bad guys win!");
                    sendGameOverEvent({
                        winner: 'bad', reason: '3 Fails!', 
                        gameProgress: game.gameProgress,
                        missionData: missionData
                    });
                    return;
                }
                // TODO: do something
            } else {
                game.addNewRound(new Round(game.round, game.numPlayers));
            }



            io.emit('mission completed', {
                game: game,
                missionData: missionData, 
                gameCode: data.gameCode,
                gameProgress: game.gameProgress,
                numSuccesses: currentRound.numSuccesses,
                numFails: currentRound.numFails,
                missionPassed: currentRound.missionPassed,
                chosen: currentRound.proposals[currentRound.proposals.length - 1].playersSelected,
                chooser: currentRound.proposals[currentRound.proposals.length - 1].selector,
                currentUser: game.turnOrder[game.currentKing],
                prevRound: game.round - 1 
            });

            if(game.round >= (DEBUG ? 2 : 3) && game.usingLadyOfLake) {
                var candidatesToUseLady = game.players.filter(function(player){
                    return !player.usedLadyOfLake;
                }).map(function(player){
                    return player.name;
                });
                console.log(game.ladyHolder.name + ' is chosen to use lady of lake!');
                io.emit('lady user chosen', {
                    user: game.ladyHolder.name, 
                    candidatesToUseLady: candidatesToUseLady,
                    gameCode: data.gameCode, 
                    currentUser: game.turnOrder[game.currentKing]
                });
            }

        
            // if(wentThrough) {
            //     io.emit('team approved', {gameCode: data.gameCode, chosen: game.currentProposal.playersSelected, playerVoteMap: playerVoteMap});
            // } else {
            //     game.currentKing = (game.currentKing + 1) % game.numPlayers;
            //     game.rejectCount++;
            //     io.emit('team rejected', {playerVoteMap: playerVoteMap, game: game, gameCode: data.gameCode, currentUser: game.turnOrder[game.currentKing]});
            // }

            //reset all the cached variables
            game.numMissionConfirmed = 0;
            game.missionVotes = undefined;
            game.missionVotePhase = false;
    
            // game.currentProposal = undefined;
        }
        //games[data.gameCode] = new GameInstance(game);
        
    });

    socket.on('lady candidate chosen', function(data) {
        var game = games[data.gameCode];
        if(!game) {
            console.log('game is undefined for the code: ' + data.gameCode);
            return;
        }
        console.log(data.chooser + ' chose to explore ' + data.candidate);
        var candidate = game.getPlayerObj(data.candidate);
        candidate.usedLadyOfLake = true;
        game.ladyHolder = candidate;

        var playersHadLady = game.players.filter(function(player){
                    return player.usedLadyOfLake;
                }).map(function(player){
                    return player.name;
                });
        io.emit('lady information', {
            playersHadLady: playersHadLady,
            turnOrder: game.turnOrder,
            gameCode: data.gameCode, 
            candidateTeam: candidate.team, 
            chooser: data.chooser, 
            candidate: candidate.name, 
            currentUser: game.turnOrder[game.currentKing]
        });

    });

});


//main route
app.get('/', function(req, res) {
    var query = url.parse(req.url, true).query
    var passcode = query.passcode;
    if(passcode == PASS) {
        res.render('setup');
    } else {
        if(passcode == RESET) {
            console.log('Resetting the games!');
           gameLobbies = {};
           games = {};
        }
        res.render('dummy');
    }

});



//for creating new lobbies. 
app.get('/join', function(req, res) {
	console.log(req.url)
    var query = url.parse(req.url, true).query
    var username = query.username;
    var gameCode = query.gameCode;
    var password = query.password;

    if(password.toLowerCase().trim() == PASSWORD_ACTIVATE) {
        can_play = true;
    }
    else if(password.toLowerCase().trim() == PASSWORD_DEACTIVATE) {
        can_play = false;
    } else if(password.toLowerCase().trim() == PASSWORD_CLEAN) {
        gameLobbies = {};
        games = {};
    } else if(password.toLowerCase().trim() == PASSWORD_CLEAN_AND_KILL) {
        gameLobbies = {};
        games = {};
        can_play = false;
    } 

    if(gameCode in gameLobbies) {
    	console.log('joining lobby')
    	var currLobby = gameLobbies[gameCode];
        if(currLobby.usernames.indexOf(username) == -1) {
            io.emit('player join', {newPlayer: username, gameCode: gameCode});
            currLobby.usernames.push(username);
        } else {
            console.log('duplicate player with name: ' + username);
        }
    	console.log(currLobby.usernames);
    } else {
        io.emit('player join', {newPlayer: username, gameCode: gameCode});
    	console.log('creating new lobby')
    	gameLobbies[gameCode] = new GameLobby(gameCode, username);
    	//COMMENNT THIS OUT LATER !
        if(DEBUG) {
        	for (var i = 0; i < DEBUG_TO_ADD; i++) {
        		gameLobbies[gameCode].usernames.push('user'+(i+1));
        	}
        }
    }
    console.log('join: UserName is ' + username + ' game code is: ' + gameCode);
    res.render('lobby');
});


//api method for getting information about the game
//params: the gameCode and the username
//returns character specific information.
app.get('/gameInfo', function(req, res) {
    var query = url.parse(req.url, true).query
    var gameCode = query.gameCode;
    var username = query.username;

    console.log('user name: ' + username +  ' game code: ' + gameCode);

    var game = games[gameCode];
    if(!game) {
        console.log('Game not found with code: ' + gameCode);
        return;
    }

    var playerObj = game.getPlayerObj(username);
    var playerInfo = {role: playerObj.role, team: playerObj.team};
    var missionData = getMissionData(game);

    var playersHadLady = game.players.filter(function(player){
                    return player.usedLadyOfLake;
                }).map(function(player){
                    return player.name;
                });

    var payload = 
    {
        player: playerInfo, 
        playersHadLady: playersHadLady,
        usingLadyOfLake: game.usingLadyOfLake,
        ladyHolder: (game.ladyHolder ? game.ladyHolder.name: null),
        round: game.round, 
        gameCode: gameCode,
        missionData: missionData,
        turnOrder: game.turnOrder,
        currentKing: game.turnOrder[game.currentKing],
        gameProgress: game.gameProgress, 
        goodChars: game.goodChars, 
        badChars: game.badChars,
        numPlayers: game.goodChars.length + game.badChars.length, 
        votes: game.votes, 
        missionVotes: game.missionVotes, 
        currentProposal: game.currentProposal, 
        players: game.players, 
        missionVotePhase: game.missionVotePhase, 
        oldProposal : game.oldProposal
    };

    if(playerInfo.role === 'merlin') {
        var knownBadPlayers = []; //except mordred
        for(var i = 0; i < game.players.length; i++) {
            if(game.players[i].role != 'mordred' && game.players[i].team == 'bad') {
                knownBadPlayers.push(game.players[i].name);
            } else if(game.players[i].role == 'lancelot') {
                knownBadPlayers.push(game.players[i].name);
            }
        }
        payload['knowledge'] = "Known Bad Players (not including mordred), and lancelot (in no particular order): " + knownBadPlayers.toString();
    } else if(playerInfo.role !== 'oberon' && playerInfo.team === 'bad') {  //mordred, morgana, assassin, vader
        var knownBadPlayers = []; //except oberon
        for(var i = 0; i < game.players.length; i++) {
            if(game.players[i].role != 'oberon' && game.players[i].team == 'bad') {
                knownBadPlayers.push(game.players[i].name);
            } else if(game.players[i].role == 'arthur') {
                knownBadPlayers.push(game.players[i].name);
            }
        }
        payload['knowledge'] = "Known Bad Players (not including oberon), and arthur: " + knownBadPlayers.toString(); 
    } else if(playerInfo.role === 'percival') {
        var knownPlayers = []; //except oberon
        for(var i = 0; i < game.players.length; i++) {
            if(game.players[i].role == 'morgana' || game.players[i].role == 'merlin' ) {
                knownPlayers.push(game.players[i].name);
            }
        }
        payload['knowledge'] = "Known Players (merlin/morgana) in no particular order: " + knownPlayers.toString(); 
    }  else { //servants, arthur, lancelot and oberon
        payload['knowledge'] = "You know nothing!";
    }

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({payload})); 

});

//renders the actual game
app.get('/game', function(req, res) {
    var query = url.parse(req.url, true).query
    var gameCode = query.gameCode;
    var username = query.username;
    res.render('game', {gameCode: gameCode, username: username});
});

//api method for returning the current players
app.get('/gameLobby', function(req, res) {
	var query = url.parse(req.url, true).query
    var gameCode = query.gameCode;
    var players_ = gameLobbies[gameCode].usernames;
    //console.log('inside game lobby ' + gameCode)
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ players: players_ }));
});

