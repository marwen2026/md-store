# Présentation du projet M&D Store

## Résumé

M&D Store est une boutique en ligne avec un espace d'administration destiné à
gérer le catalogue, les commandes et les expéditions. L'interface est adaptée
aux langues arabe et française. Le serveur Node.js/Express utilise PostgreSQL
pour conserver les données.

## Proposition de présentation orale

> M&D Store est une application de commerce en ligne conçue pour réunir
> l'expérience d'achat et la gestion quotidienne d'une boutique. Les clients
> peuvent parcourir les produits, filtrer le catalogue, remplir leur panier et
> passer une commande avec paiement à la livraison. Le serveur vérifie le stock
> et enregistre les articles et les coordonnées du client.
>
> Depuis l'espace d'administration, les responsables gèrent les produits et les
> catégories, suivent les commandes, mettent à jour leur statut et créent des
> expéditions groupées. Ils peuvent aussi consulter les factures PDF, les
> statistiques et l'historique des changements d'état d'une commande. Un journal
> dédié conserve les actions effectuées par les administrateurs.
>
> Le projet repose sur Express, PostgreSQL et une interface web en HTML, CSS et
> JavaScript. L'authentification utilise des jetons JWT, les mots de passe sont
> hachés, et les rôles administrateur et manager limitent les opérations
> disponibles. Le déploiement peut se faire avec Docker Compose.

## Plan de diapositives

1. **Contexte et objectif** — Présenter M&D Store et le besoin d'une gestion
   simple des ventes en ligne.
2. **Parcours client** — Catalogue, recherche, panier, validation du stock et
   commande avec paiement à la livraison.
3. **Espace d'administration** — Gestion du catalogue, des commandes, des
   clients, des utilisateurs et des expéditions.
4. **Suivi et traçabilité** — Factures PDF, statistiques, historique des statuts
   de commande et journal des actions administrateur.
5. **Architecture et sécurité** — Interface web, API Express, base PostgreSQL,
   authentification JWT, rôles et déploiement Docker.
6. **Démonstration et suites possibles** — Réaliser une commande, la mettre à
   jour depuis l'administration, puis consulter son historique.

## Démonstration suggérée

1. Ouvrir la boutique et parcourir ou rechercher un produit.
2. Ajouter un produit au panier et soumettre une commande de test.
3. Se connecter à `/admin`, afficher la nouvelle commande et ouvrir son
   historique.
4. Modifier son statut et vérifier le nouvel événement dans l'historique.
5. Consulter le journal admin ainsi que les documents d'historique et de
   présentation du projet.

## Lancement

Suivre les instructions de configuration et de démarrage dans [README.md](./README.md).
