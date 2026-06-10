# MindChess Online POC

MindChess Online est une preuve de concept multijoueur en temps réel : deux joueurs jouent une partie d'échecs simplifiée et voient le curseur, le drag, les halos et les hésitations de l'autre joueur.

Le serveur utilise les pièces SVG placées dans `./pieces` depuis ce projet, par exemple `wP.svg`, `bK.svg`, etc.

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

Puis ouvrir :

```text
http://localhost:3000
```

## Test avec deux ou trois onglets

1. Ouvre `http://localhost:3000` dans un premier onglet.
   Tu deviens Blanc et tu vois `Tu es Blanc` puis `En attente du joueur Noir`.
2. Ouvre la même URL dans un deuxième onglet.
   Tu deviens Noir et les deux onglets indiquent que les deux joueurs sont connectés.
3. Bouge la souris côté Blanc.
   Le joueur Noir voit le curseur blanc, sa traînée et ses halos.
4. Bouge la souris côté Noir.
   Le joueur Blanc voit le curseur noir, sa traînée et ses halos.
5. Déplace une pièce.
   Le serveur valide le coup simplifié, puis les deux échiquiers se synchronisent.
6. Ouvre un troisième onglet.
   Il devient spectateur, ne peut pas jouer et voit les intentions des deux joueurs.
7. Choisis un avatar dans chaque onglet joueur.
   L'adversaire le voit dans le panneau de présence.
8. Envoie un message dans le chat.
   L'autre joueur le reçoit immédiatement.
9. Teste roque, prise en passant et promotion.
   Le serveur synchronise aussi la tour du roque et la piece choisie en promotion.

## Limites du POC

- Les coups sont valides cote serveur : echec, mat, pat, roque, prise en passant, promotion, repetition triple, 50 coups et materiel insuffisant.
- Pas encore de pendule.
- Pas de comptes utilisateurs.
- Une seule room.
- Pas de matchmaking.
- Pas de persistance après redémarrage serveur.
- Pas encore de vraie sécurité production.
- Prototype destiné à tester la sensation : voir l'intention adverse.

## Prochaines étapes

- Plusieurs rooms.
- Liens d'invitation.
- Pseudonymes.
- Vrais coups légaux.
- Mode spectateur public.
- Mode bluff.
- Commentaires audio.
- Analyse post-partie.
