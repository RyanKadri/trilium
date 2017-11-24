"use strict";

const express = require('express');
const router = express.Router();
const sql = require('../../services/sql');
const utils = require('../../services/utils');
const audit_category = require('../../services/audit_category');
const auth = require('../../services/auth');
const sync_table = require('../../services/sync_table');

router.put('/:noteTreeId/moveTo/:parentNoteId', auth.checkApiAuth, async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const parentNoteId = req.params.parentNoteId;

    const maxNotePos = await sql.getSingleValue('SELECT MAX(note_pos) FROM notes_tree WHERE note_pid = ? AND is_deleted = 0', [parentNoteId]);
    const newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;

    const now = utils.nowTimestamp();

    await sql.doInTransaction(async () => {
        await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
            [parentNoteId, newNotePos, now, noteTreeId]);

        await sync_table.addNoteTreeSync(noteTreeId);
        await sql.addAudit(audit_category.CHANGE_PARENT, utils.browserId(req), null, null, parentNoteId);
    });

    res.send({});
});

router.put('/:noteTreeId/moveBefore/:beforeNoteTreeId', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const beforeNoteTreeId = req.params.beforeNoteTreeId;

    const beforeNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [beforeNoteTreeId]);

    if (beforeNote) {
        await sql.doInTransaction(async () => {
            // we don't change date_modified so other changes are prioritized in case of conflict
            await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos >= ? AND is_deleted = 0",
                [beforeNote.note_pid, beforeNote.note_pos]);

            const now = utils.nowTimestamp();

            await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
                [beforeNote.note_pid, beforeNote.note_pos, now, noteTreeId]);

            await sync_table.addNoteTreeSync(noteTreeId);
            await sync_table.addNoteReorderingSync(beforeNote.note_pid);
            await sql.addAudit(audit_category.CHANGE_POSITION, utils.browserId(req), beforeNote.note_pid);
        });

        res.send({});
    }
    else {
        res.status(500).send("Before note " + beforeNoteTreeId + " doesn't exist.");
    }
});

router.put('/:noteTreeId/moveAfter/:afterNoteTreeId', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const afterNoteTreeId = req.params.afterNoteTreeId;

    const afterNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [afterNoteTreeId]);

    if (afterNote) {
        await sql.doInTransaction(async () => {
            // we don't change date_modified so other changes are prioritized in case of conflict
            await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos > ? AND is_deleted = 0",
                [afterNote.note_pid, afterNote.note_pos]);

            const now = utils.nowTimestamp();

            await sql.execute("UPDATE notes_tree SET note_pid = ?, note_pos = ?, date_modified = ? WHERE note_tree_id = ?",
                [afterNote.note_pid, afterNote.note_pos + 1, now, noteTreeId]);

            await sync_table.addNoteTreeSync(noteTreeId);
            await sync_table.addNoteReorderingSync(afterNote.note_pid);
            await sql.addAudit(audit_category.CHANGE_POSITION, utils.browserId(req), afterNote.note_pid);
        });

        res.send({});
    }
    else {
        res.status(500).send("After note " + afterNoteTreeId + " doesn't exist.");
    }
});

router.put('/:childNoteId/cloneTo/:parentNoteId', auth.checkApiAuth, async (req, res, next) => {
    const parentNoteId = req.params.parentNoteId;
    const childNoteId = req.params.childNoteId;

    const existing = await sql.getSingleValue('SELECT * FROM notes_tree WHERE note_id = ? AND note_pid = ?', [childNoteId, parentNoteId]);

    if (existing && !existing.is_deleted) {
        res.send({
            success: false,
            message: 'This note already exists in target parent note.'
        });

        return;
    }

    const maxNotePos = await sql.getSingleValue('SELECT MAX(note_pos) FROM notes_tree WHERE note_pid = ? AND is_deleted = 0', [parentNoteId]);
    const newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;

    await sql.doInTransaction(async () => {
        const noteTree = {
            'note_tree_id': utils.newNoteTreeId(),
            'note_id': childNoteId,
            'note_pid': parentNoteId,
            'note_pos': newNotePos,
            'is_expanded': 0,
            'date_modified': utils.nowTimestamp(),
            'is_deleted': 0
        };

        await sql.replace("notes_tree", noteTree);

        await sync_table.addNoteTreeSync(noteTree.note_tree_id);

        res.send({
            success: true
        });
    });
});

router.put('/:noteId/cloneAfter/:afterNoteTreeId', async (req, res, next) => {
    const noteId = req.params.noteId;
    const afterNoteTreeId = req.params.afterNoteTreeId;

    const afterNote = await sql.getSingleResult("SELECT * FROM notes_tree WHERE note_tree_id = ?", [afterNoteTreeId]);

    if (!afterNote) {
        res.status(500).send("After note " + afterNoteTreeId + " doesn't exist.");
        return;
    }

    const existing = await sql.getSingleValue('SELECT * FROM notes_tree WHERE note_id = ? AND note_pid = ?', [noteId, afterNote.note_pid]);

    if (existing && !existing.is_deleted) {
        res.send({
            success: false,
            message: 'This note already exists in target parent note.'
        });

        return;
    }

    await sql.doInTransaction(async () => {
        // we don't change date_modified so other changes are prioritized in case of conflict
        await sql.execute("UPDATE notes_tree SET note_pos = note_pos + 1 WHERE note_pid = ? AND note_pos > ? AND is_deleted = 0",
            [afterNote.note_pid, afterNote.note_pos]);

        const noteTree = {
            'note_tree_id': utils.newNoteTreeId(),
            'note_id': noteId,
            'note_pid': afterNote.note_pid,
            'note_pos': afterNote.note_pos + 1,
            'is_expanded': 0,
            'date_modified': utils.nowTimestamp(),
            'is_deleted': 0
        };

        await sql.replace("notes_tree", noteTree);

        await sync_table.addNoteTreeSync(noteTree.note_tree_id);
        await sync_table.addNoteReorderingSync(afterNote.note_pid);
        await sql.addAudit(audit_category.CHANGE_POSITION, utils.browserId(req), afterNote.note_pid);

        res.send({
            success: true
        });
    });
});

router.put('/:noteTreeId/expanded/:expanded', async (req, res, next) => {
    const noteTreeId = req.params.noteTreeId;
    const expanded = req.params.expanded;

    await sql.doInTransaction(async () => {
        await sql.execute("UPDATE notes_tree SET is_expanded = ? WHERE note_tree_id = ?", [expanded, noteTreeId]);
    });

    res.send({});
});

module.exports = router;